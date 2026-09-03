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
import { buildSystemPrompt } from './prompt';
import type { McpServerConfig } from '../mcp/types';
import type { MemoryEntry } from '../memory/types';
import type { NewMemoryEntry } from '../memory/store';
import { extractRule } from '../memory/rules';
import { buildToolSchemas, executeTool, indexBlobsByPath, type ToolRuntime } from './tools';

/** Teto de idas e voltas com o modelo em um unico turno do usuario. */
const MAX_STEPS = 16;
/** Mensagens de historico enviadas ao modelo (as mais recentes). */
const HISTORY_WINDOW = 60;
/** Teto do raciocinio guardado por passo. So a exibicao usa isso. */
const MAX_REASONING_CHARS = 4000;

function trimReasoning(reasoning: string | undefined): string | undefined {
  if (!reasoning) return undefined;
  return reasoning.length <= MAX_REASONING_CHARS
    ? reasoning
    : `${reasoning.slice(0, MAX_REASONING_CHARS)}\n... (raciocinio truncado)`;
}

export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'assistant-delta'; text: string }
  /** Raciocinio chegando token a token, antes de o modelo produzir a resposta. */
  | { type: 'reasoning-delta'; text: string }
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

/** Converte o historico persistido em turnos neutros de provedor. */
export function historyToTurns(history: ChatMessage[]): ProviderTurn[] {
  const window = history.slice(-HISTORY_WINDOW);
  // Nunca comecar por um resultado de tool orfao: o modelo rejeita.
  while (window.length > 0 && window[0].role !== 'user') window.shift();

  const turns: ProviderTurn[] = [];
  for (const message of window) {
    if (message.role === 'user') {
      turns.push({ role: 'user', text: withAttachmentNote(message) });
    } else if (message.role === 'assistant') {
      turns.push({
        role: 'assistant',
        text: message.content || undefined,
        toolCalls: message.toolCalls,
      });
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

  const system = buildSystemPrompt(
    scope,
    map,
    options.autoApply,
    options.mcpServers,
    options.memory,
  );
  const tools = buildToolSchemas(options.mcpServers);
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
    { role: 'user', text: options.userText, ...(imagens.length > 0 ? { images: imagens } : {}) },
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

  for (let step = 0; step < MAX_STEPS; step++) {
    if (options.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

    // Ultima barreira antes de a requisicao sair da maquina.
    assertNoForeignRepoLeak(
      scope,
      leakCheckPayload({ system, turns }),
      options.connectedRepoIds,
      userAuthoredText,
    );

    onEvent({ type: 'status', text: step === 0 ? 'Pensando...' : 'Analisando o repositorio...' });

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
          ? '(o modelo nao produziu resposta final — o raciocinio dele esta acima)'
          : response.text,
      reasoning: trimReasoning(response.reasoning),
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
          'A conexao caiu no meio da resposta. O que chegou esta acima; envie de novo para continuar.',
      });
      break;
    }

    if (silentTurn) {
      onEvent({
        type: 'error',
        error: response.reasoning
          ? 'O modelo devolveu apenas raciocinio, sem resposta final. Peca de novo, ou use ' +
            'outro modelo — alguns modelos de raciocinio se perdem depois de varias rodadas de leitura.'
          : 'O modelo encerrou o turno sem produzir resposta nem chamar ferramentas. Peca de novo, ' +
            'seja mais especifico, ou tente outro modelo.',
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
