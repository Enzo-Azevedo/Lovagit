import type { AIProvider, ProviderTurn } from '../ai/types';
import type { ApplyResult } from '../github/writer';
import type { ChatMessage, PendingFileChange, RepoId, RepoMap, ToolCall } from '../types';
import { assertNoForeignRepoLeak, assertScopedMap, type RepoScope } from './isolation';
import { buildSystemPrompt } from './prompt';
import type { McpServerConfig } from '../mcp/types';
import { buildToolSchemas, executeTool, type ToolRuntime } from './tools';

/** Teto de idas e voltas com o modelo em um unico turno do usuario. */
const MAX_STEPS = 16;
/** Mensagens de historico enviadas ao modelo (as mais recentes). */
const HISTORY_WINDOW = 60;

export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'assistant-delta'; text: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'tool-start'; call: ToolCall }
  | { type: 'pending-changed'; changes: PendingFileChange[] }
  | { type: 'awaiting-approval'; message: string; changes: PendingFileChange[] }
  | { type: 'committed'; result: ApplyResult }
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface RunAgentOptions {
  scope: RepoScope;
  map: RepoMap;
  /** Historico ja filtrado pelo repositorio da conversa. */
  history: ChatMessage[];
  userText: string;
  provider: AIProvider;
  autoApply: boolean;
  /** Todos os repositorios conectados — usado apenas pelo canario de vazamento. */
  connectedRepoIds: RepoId[];
  /** Servidores MCP habilitados para ESTE repositorio (ja filtrados). */
  mcpServers: McpServerConfig[];
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

let messageCounter = 0;
function newId(prefix: string): string {
  messageCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${messageCounter}`;
}

/** Converte o historico persistido em turnos neutros de provedor. */
export function historyToTurns(history: ChatMessage[]): ProviderTurn[] {
  const window = history.slice(-HISTORY_WINDOW);
  // Nunca comecar por um resultado de tool orfao: o modelo rejeita.
  while (window.length > 0 && window[0].role !== 'user') window.shift();

  const turns: ProviderTurn[] = [];
  for (const message of window) {
    if (message.role === 'user') {
      turns.push({ role: 'user', text: message.content });
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

  const system = buildSystemPrompt(scope, map, options.autoApply, options.mcpServers);
  const tools = buildToolSchemas(options.mcpServers);
  const produced: ChatMessage[] = [];

  const userMessage: ChatMessage = {
    id: newId('msg'),
    repoId,
    role: 'user',
    content: options.userText,
    createdAt: Date.now(),
  };
  produced.push(userMessage);
  onEvent({ type: 'message', message: userMessage });

  const turns: ProviderTurn[] = [
    ...historyToTurns(options.history),
    { role: 'user', text: options.userText },
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
  let ref = map.headSha;

  const runtime: ToolRuntime = {
    scope,
    map,
    mcpServers: options.mcpServers,
    ref,
    pending,
    autoApply: options.autoApply,
    signal: options.signal,
    onPendingChanged: () => onEvent({ type: 'pending-changed', changes: [...pending.values()] }),
    onCommitted: async (result) => {
      committed = result;
      ref = result.checkpoint.commitSha;
      runtime.ref = ref;
      pending.clear();
      onEvent({ type: 'committed', result });
      onEvent({ type: 'pending-changed', changes: [] });
    },
    onAwaitingApproval: (message) => {
      awaitingApproval = message;
      onEvent({ type: 'awaiting-approval', message, changes: [...pending.values()] });
    },
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (options.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

    // Ultima barreira antes de a requisicao sair da maquina.
    assertNoForeignRepoLeak(
      scope,
      JSON.stringify({ system, turns }),
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
    });

    // Turno que nao produz texto nem chamada de ferramenta some da tela: a UI
    // nao tem o que renderizar e o usuario ve a conversa parar sem explicacao.
    const silentTurn = response.text === '' && response.toolCalls.length === 0;

    const assistantMessage: ChatMessage = {
      id: newId('msg'),
      repoId,
      role: 'assistant',
      // Modelo de raciocinio que nao produziu resposta final: mostrar o
      // raciocinio e melhor do que mostrar nada.
      content:
        silentTurn && response.reasoning
          ? `(o modelo nao produziu resposta final — abaixo o raciocinio que ele devolveu)\n\n${response.reasoning}`
          : response.text,
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

  if (committed === null && awaitingApproval === null && pending.size > 0) {
    onEvent({
      type: 'awaiting-approval',
      message: 'Alteracoes preparadas sem commit',
      changes: [...pending.values()],
    });
  }

  onEvent({ type: 'done' });
  return produced;
}
