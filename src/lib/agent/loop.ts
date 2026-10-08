import type { AIProvider, ProviderTurn } from '../ai/types';
import type { ApplyResult } from '../github/writer';
import type {
  ChatMessage,
  PendingFileChange,
  RepoId,
  RepoMap,
  ToolCall,
  TurnImage,
} from '../types';
import {
  assertNoForeignRepoLeak,
  assertScopedMap,
  leakCheckPayload,
  type RepoScope,
} from './isolation';
import { explainStepCeiling, explainStopReason } from './ending';
import { buildSystemPrompt } from './prompt';
import type { McpServerConfig } from '../mcp/types';
import type { MemoryEntry } from '../memory/types';
import type { RepoPlatformLink } from '../platforms/prompt';
import type { NewMemoryEntry } from '../memory/store';
import { extractRule } from '../memory/rules';
import {
  buildToolSchemas,
  executeTool,
  indexBlobsByPath,
  type InternetPolicy,
  type ToolRuntime,
} from './tools';

/**
 * Teto padrao de idas e voltas com o modelo em um unico turno do usuario.
 *
 * Usado quando o usuario nao configura `maxSteps` e como piso de seguranca
 * quando o MAX STEPS dinamico nao consegue contar um plano.
 */
export const DEFAULT_MAX_STEPS = 20;
/** Mensagens de historico enviadas ao modelo (as mais recentes). */
const HISTORY_WINDOW = 60;
/**
 * Teto padrao do raciocinio guardado por passo. So a exibicao usa isso: o
 * raciocinio nunca volta ao modelo — ele ja sabe o que pensou, e alguns
 * provedores recusam o campo de volta. Configuravel nas opcoes.
 */
const DEFAULT_MAX_REASONING_CHARS = 32_000;

/**
 * Instrucao do plano no modo MAX STEPS dinamico. ASCII de proposito: vai para o
 * modelo, nao para a tela.
 */
const PLAN_PROMPT = [
  'Voce vai planejar este turno antes de executar.',
  'Liste os passos que pretende executar, um por linha, como lista numerada.',
  'Cada passo deve ser uma acao de ferramenta (ler, buscar, escrever, remover, commit).',
  'Responda SOMENTE com a lista numerada, sem introducao e sem conclusao.',
].join('\n');

/**
 * Conta os itens de uma lista de plano produzida pelo modelo.
 *
 * Aceita lista numerada (`1.`, `2)`) e marcadores (`-`, `*`, `+`, `•`). Linha
 * que nao casa com o padrao de item nao conta: titulo, explicacao e conclusao
 * nao sao passos.
 */
export function countPlanSteps(planText: string): number {
  return planText
    .split('\n')
    .map((linha) => linha.trim())
    .filter((linha) => /^(?:\d{1,3}[.)]|[-*+•])\s+/.test(linha)).length;
}

function trimReasoning(reasoning: string | undefined, limit: number): string | undefined {
  if (!reasoning) return undefined;
  return reasoning.length <= limit
    ? reasoning
    : `${reasoning.slice(0, limit)}\n... (raciocínio truncado)`;
}

export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'assistant-delta'; text: string }
  /** Raciocinio chegando token a token, antes de o modelo produzir a resposta. */
  | { type: 'reasoning-delta'; text: string }
  /** Plano listado pelo modelo no modo MAX STEPS dinamico. */
  | { type: 'plan'; text: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'tool-start'; call: ToolCall }
  | { type: 'pending-changed'; changes: PendingFileChange[] }
  /** `commitMessage: null` = o modelo preparou arquivos sem propor mensagem. */
  | { type: 'awaiting-approval'; commitMessage: string | null; changes: PendingFileChange[] }
  | { type: 'committed'; result: ApplyResult }
  /** Fato para a memoria do repositorio. Quem grava e' a camada de cima. */
  | { type: 'memory'; entry: NewMemoryEntry }
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface RunAgentOptions {
  scope: RepoScope;
  map: RepoMap;
  /** Historico ja filtrado pelo repositorio da conversa. */
  history: ChatMessage[];
  userText: string;
  /**
   * Imagens anexadas a ESTE turno. Nao entram no historico: uma captura de tela
   * em base64 seria reenviada em todo turno seguinte, multiplicando o custo e
   * enchendo a cota do storage.
   */
  images?: TurnImage[];
  provider: AIProvider;
  autoApply: boolean;
  /** Todos os repositorios conectados — usado apenas pelo canario de vazamento. */
  connectedRepoIds: RepoId[];
  /** Servidores MCP habilitados para ESTE repositorio (ja filtrados). */
  mcpServers: McpServerConfig[];
  /** Memoria ja gravada DESTE repositorio, para o system prompt. */
  memory: MemoryEntry[];
  /** Projetos de plataforma vinculados a ESTE repositorio (ja resolvidos). */
  platformLinks?: RepoPlatformLink[];
  /**
   * Internet no turno. `enabled` oferece `web_search` ao modelo; `onlyWhenStuck`
   * exige justificativa de duvida severa, conferida na execucao (nao so no prompt).
   */
  internet?: InternetPolicy;
  /**
   * Teto do raciocinio guardado por passo (so exibicao). Ausente = padrao.
   */
  maxReasoningChars?: number;
  /**
   * Teto de passos deste turno. Padrao: `DEFAULT_MAX_STEPS`.
   *
   * Quando `dynamicMaxSteps` esta ligado, este valor vira piso de seguranca e o
   * teto real vem do plano: o modelo lista as tarefas antes de comecar, e o
   * turno ganha `itens do plano + 1` passos.
   */
  maxSteps?: number;
  /**
   * MAX STEPS dinamico. Veja `maxSteps`.
   */
  dynamicMaxSteps?: boolean;
  /**
   * O que o modelo ja tinha gerado num turno anterior que caiu.
   *
   * Acompanha o turno enviado ao provedor, mas NAO a mensagem gravada no chat:
   * quem le a conversa quer ver o proprio pedido, nao o rascunho de uma
   * tentativa que morreu.
   */
  resumeHint?: string;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

let messageCounter = 0;
function newId(prefix: string): string {
  messageCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${messageCounter}`;
}

/**
 * Marca no texto que houve anexo, ja que a imagem nao volta.
 *
 * Sem isso o modelo leria "o que ha de errado nesta tela?" sem tela nenhuma e
 * responderia com chute. Com a marca, ele sabe que existiu uma imagem que nao
 * esta mais visivel — e pode pedir de novo.
 */
export function withAttachmentNote(message: ChatMessage): string {
  const anexos = message.attachments ?? [];
  if (anexos.length === 0) return message.content;
  const lista = anexos.map((anexo) => anexo.name).join(', ');
  return `${message.content}
[${anexos.length} imagem(ns) enviada(s) neste turno: ${lista} — nao estao mais visiveis]`;
}

/**
 * Converte o historico persistido em turnos neutros de provedor.
 *
 * O historico pode carregar uma mensagem de assistente com `toolCalls` sem os
 * resultados correspondentes: turno abortado (ou que caiu) entre a chamada de
 * ferramenta e a execucao dela. Reenviar essa mensagem faz o provedor recusar o
 * payload com 400 — "an assistant message with 'tool_calls' must be followed by
 * tool messages responding to each 'tool_call_id'". Por isso a conversao
 * sanitiza: assistant com tool calls sem TODOS os resultados entra so com o
 * texto (se houver), e as mensagens de tool que responderiam a ela sao
 * descartadas junto — sem a assistant, elas tambem seriam resultados orfaos.
 */
export function historyToTurns(history: ChatMessage[]): ProviderTurn[] {
  const window = history.slice(-HISTORY_WINDOW);
  // Nunca comecar por um resultado de tool orfao: o modelo rejeita.
  while (window.length > 0 && window[0].role !== 'user') window.shift();

  const turns: ProviderTurn[] = [];
  for (let i = 0; i < window.length; i++) {
    const message = window[i];

    if (message.role === 'assistant') {
      const toolCalls = message.toolCalls ?? [];
      if (toolCalls.length > 0) {
        // Assistant com tool calls exige resposta para TODOS os ids nas
        // mensagens `tool` imediatamente seguintes.
        const pendentes = new Set(toolCalls.map((call) => call.id));
        let j = i + 1;
        while (j < window.length && window[j].role === 'tool') {
          for (const result of window[j].toolResults ?? []) pendentes.delete(result.toolCallId);
          j++;
        }
        if (pendentes.size === 0) {
          turns.push({
            role: 'assistant',
            text: message.content || undefined,
            toolCalls,
          });
          continue;
        }
        // Orfa (ou parcial): os tool calls nao podem ir, e os resultados que
        // responderiam a eles tambem nao. Sobra so o texto, se houver.
        if (message.content) {
          turns.push({ role: 'assistant', text: message.content });
        }
        i = j - 1; // pula as mensagens tool consumidas acima
        continue;
      }
      turns.push({ role: 'assistant', text: message.content || undefined });
      continue;
    }

    if (message.role === 'user') {
      turns.push({ role: 'user', text: withAttachmentNote(message) });
    } else if (message.role === 'tool') {
      turns.push({ role: 'user', toolResults: message.toolResults });
    }
  }
  return turns;
}

/**
 * Executa um turno completo: chama o modelo, roda as tools que ele pedir e
 * repete ate ele parar de pedir tools. Devolve as mensagens novas para persistir.
 */
export async function runAgent(options: RunAgentOptions): Promise<ChatMessage[]> {
  const { scope, provider, onEvent } = options;
  const map = assertScopedMap(scope, options.map);
  const repoId = scope.repoId;
  const internet = options.internet;
  const maxReasoningChars = options.maxReasoningChars ?? DEFAULT_MAX_REASONING_CHARS;

  const system = buildSystemPrompt(
    scope,
    map,
    options.autoApply,
    options.mcpServers,
    options.memory,
    options.platformLinks ?? [],
    internet,
  );
  const tools = buildToolSchemas(options.mcpServers, internet);
  const produced: ChatMessage[] = [];

  const imagens = options.images ?? [];
  const userMessage: ChatMessage = {
    id: newId('msg'),
    repoId,
    role: 'user',
    content: options.userText,
    // Fica so o registro de que houve anexo; o conteudo morre com o turno.
    attachments:
      imagens.length > 0
        ? imagens.map((imagem, indice) => ({
            name: `imagem-${indice + 1}`,
            mediaType: imagem.mediaType,
            bytes: Math.round((imagem.dataBase64.length * 3) / 4),
          }))
        : undefined,
    createdAt: Date.now(),
  };
  produced.push(userMessage);
  onEvent({ type: 'message', message: userMessage });

  const turns: ProviderTurn[] = [
    ...historyToTurns(options.history),
    {
      role: 'user',
      text: options.resumeHint
        ? `${options.userText}\n\n${options.resumeHint}`
        : options.userText,
      ...(imagens.length > 0 ? { images: imagens } : {}),
    },
  ];

  // Tudo que o usuario escreveu nesta conversa: separa "usuario citou outro
  // repositorio" (bloqueio esperado) de "nosso codigo vazou" (defeito).
  const userAuthoredText = [
    ...options.history.filter((m) => m.role === 'user').map((m) => m.content),
    options.userText,
  ].join('\n');

  const pending = new Map<string, PendingFileChange>();
  let committed: ApplyResult | null = null;
  let awaitingApproval: string | null = null;
  /** O modelo ja registrou memoria neste turno? Se sim, o detector se cala. */
  let lembrou = false;
  let ref = map.headSha;

  const runtime: ToolRuntime = {
    scope,
    map,
    // Uma vez por turno, reutilizado por toda leitura e escrita do passo.
    blobsByPath: indexBlobsByPath(map),
    mcpServers: options.mcpServers,
    ref,
    pending,
    autoApply: options.autoApply,
    internet,
    signal: options.signal,
    onPendingChanged: () => onEvent({ type: 'pending-changed', changes: [...pending.values()] }),
    onCommitted: async (result) => {
      committed = result;
      // O commit NAO vira memoria aqui. Quem grava e' quem persiste o
      // checkpoint, porque o mesmo commit tambem acontece pelo botao de
      // aprovacao manual — fora deste laco. Gravar nos dois lugares
      // duplicaria; gravar so aqui perdia todo commit aprovado na mao.
      ref = result.checkpoint.commitSha;
      runtime.ref = ref;
      pending.clear();
      onEvent({ type: 'committed', result });
      onEvent({ type: 'pending-changed', changes: [] });
    },
    onRemember: (summary, detail) => {
      lembrou = true;
      onEvent({ type: 'memory', entry: { repoId, kind: 'decision', summary, detail } });
    },
    onAwaitingApproval: (message) => {
      awaitingApproval = message;
      onEvent({ type: 'awaiting-approval', commitMessage: message, changes: [...pending.values()] });
    },
  };

  /**
   * Teto do turno. No modo dinamico, o modelo lista o plano antes de executar e
   * o teto vira o numero de itens + 1 — o +1 existe porque o proprio plano
   * consome o passo zero do laco. Se o plano nao vier ou nao puder ser contado,
   * vale o teto configurado (ou o padrao).
   */
  let maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (options.dynamicMaxSteps) {
    onEvent({ type: 'status', text: 'Planejando os passos deste turno...' });
    const planRequest = [
      PLAN_PROMPT,
      '',
      `Pedido: ${options.userText}`,
      ...(options.resumeHint ? ['', options.resumeHint] : []),
    ].join('\n');
    try {
      const plano = await provider.complete({
        system,
        turns: [{ role: 'user', text: planRequest }],
        tools: [],
        signal: options.signal,
      });
      const texto = plano.text.trim();
      if (texto) onEvent({ type: 'plan', text: texto });
      const itens = countPlanSteps(texto);
      if (itens > 0) maxSteps = itens + 1;
    } catch (error) {
      // Planejar e' otimizacao do teto, nao o trabalho em si: se o modelo nao
      // devolver um plano, o turno segue com o teto configurado. Cancelamento
      // nao e' falha de plano — sobe para encerrar o turno.
      if ((error as Error)?.name === 'AbortError') throw error;
    }
    onEvent({ type: 'status', text: '' });
  }

  /** O laco terminou por ter acabado as voltas, e nao porque o modelo parou. */
  let esgotouPassos = false;

  for (let step = 0; step < maxSteps; step++) {
    if (options.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

    // Ultima barreira antes de a requisicao sair da maquina.
    assertNoForeignRepoLeak(
      scope,
      leakCheckPayload({ system, turns }),
      options.connectedRepoIds,
      userAuthoredText,
    );

    onEvent({ type: 'status', text: step === 0 ? 'Pensando...' : 'Analisando o repositório...' });

    const response = await provider.complete({
      system,
      turns,
      tools,
      signal: options.signal,
      onText: (delta) => onEvent({ type: 'assistant-delta', text: delta }),
      onReasoning: (delta) => onEvent({ type: 'reasoning-delta', text: delta }),
    });

    // Turno que nao produz texto nem chamada de ferramenta some da tela: a UI
    // nao tem o que renderizar e o usuario ve a conversa parar sem explicacao.
    const silentTurn = response.text === '' && response.toolCalls.length === 0;

    const assistantMessage: ChatMessage = {
      id: newId('msg'),
      repoId,
      role: 'assistant',
      // Modelo de raciocinio que nao produziu resposta final: o raciocinio fica
      // no campo proprio, logo acima, entao aqui basta explicar o que houve.
      content:
        silentTurn && response.reasoning
          ? '(o modelo não produziu resposta final — o raciocínio dele está acima)'
          : response.text,
      reasoning: trimReasoning(response.reasoning, maxReasoningChars),
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      createdAt: Date.now(),
    };
    produced.push(assistantMessage);
    onEvent({ type: 'message', message: assistantMessage });

    turns.push({
      role: 'assistant',
      text: response.text || undefined,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    });

    // Resposta truncada por queda de conexao: o texto que chegou fica no chat,
    // mas o turno encerra aqui. Seguir adiante seria agir sobre uma resposta
    // que o modelo nao terminou de dar.
    if (response.stopReason === 'interrupted') {
      onEvent({
        type: 'error',
        error:
          'A conexão caiu no meio da resposta. O que chegou está acima; envie de novo para continuar.',
      });
      break;
    }

    // Corte do provedor (teto de tokens, filtro de conteudo) nao e' fim normal.
    // Passava como se fosse, e o usuario lia meia resposta como resposta pronta.
    const corte = explainStopReason(response.stopReason);
    if (corte) {
      onEvent({ type: 'error', error: corte });
      break;
    }

    if (silentTurn) {
      onEvent({
        type: 'error',
        error: response.reasoning
          ? 'O modelo devolveu apenas raciocínio, sem resposta final. Peça de novo, ou use ' +
            'outro modelo — alguns modelos de raciocínio se perdem depois de várias rodadas de leitura.'
          : 'O modelo encerrou o turno sem produzir resposta nem chamar ferramentas. Peça de novo, ' +
            'seja mais específico, ou tente outro modelo.',
      });
      break;
    }

    if (response.toolCalls.length === 0) break;

    const results = [];
    for (const call of response.toolCalls) {
      onEvent({ type: 'tool-start', call });
      results.push(await executeTool(runtime, call));
    }

    const toolMessage: ChatMessage = {
      id: newId('msg'),
      repoId,
      role: 'tool',
      content: '',
      toolResults: results,
      createdAt: Date.now(),
    };
    produced.push(toolMessage);
    onEvent({ type: 'message', message: toolMessage });
    turns.push({ role: 'user', toolResults: results });

    // Alteracoes aguardando aprovacao encerram o turno: quem decide e' o usuario.
    if (awaitingApproval) break;

    // Chegou ao fim do corpo na ultima volta: o modelo ainda queria continuar e
    // quem encerrou foi o teto. Marcado aqui, e nao depois do laco, porque so
    // neste ponto da para distinguir "acabaram as voltas" de "o modelo parou".
    if (step === maxSteps - 1) esgotouPassos = true;
  }

  // Sem isto, estourar o teto era o unico encerramento sem aviso nenhum: a
  // conversa parava e ficava igualzinha a um turno que terminou bem.
  if (esgotouPassos) {
    onEvent({ type: 'error', error: explainStepCeiling(maxSteps) });
  }

  // O modelo mexeu em arquivos e encerrou sem chamar commit_changes. Sem
  // mensagem proposta: quem decide o texto do commit e o usuario, nao uma
  // string interna desta funcao.
  if (committed === null && awaitingApproval === null && pending.size > 0) {
    onEvent({ type: 'awaiting-approval', commitMessage: null, changes: [...pending.values()] });
  }

  // Regra dita pelo usuario vira memoria sozinha — ele nao precisa pedir "guarde
  // isso". E vale mesmo em turno sem consequencia nenhuma: "sempre use aspas
  // simples" nao muda arquivo hoje, e e' exatamente o que precisa valer amanha.
  //
  // A porta principal continua sendo o modelo chamando `remember`, com resumo
  // melhor que qualquer recorte de texto; este caminho so cobre o turno em que
  // ele nao chamou nada.
  const regra = lembrou ? null : extractRule(options.userText);
  if (regra !== null) {
    onEvent({
      type: 'memory',
      entry: { repoId, kind: 'decision', summary: regra, detail: options.userText },
    });
  } else if (committed !== null || pending.size > 0) {
    // Pedido comum so vira memoria quando o turno teve consequencia. Turno de
    // pergunta e resposta nao merece entrada: memoria cheia de ruido atrapalha
    // tanto quanto memoria nenhuma.
    onEvent({
      type: 'memory',
      entry: { repoId, kind: 'request', summary: options.userText, detail: options.userText },
    });
  }

  onEvent({ type: 'done' });
  return produced;
}
