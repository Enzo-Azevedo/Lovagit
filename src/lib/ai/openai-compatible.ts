import type { ToolCall } from '../types';
import {
  ProviderError,
  type AIProvider,
  type CompletionRequest,
  type CompletionResponse,
  type ProviderErrorKind,
} from './types';

/**
 * Cliente para qualquer endpoint no formato OpenAI (`POST /chat/completions`):
 * OpenAI, Groq, OpenRouter, Together, Gemini via camada compativel, LM Studio,
 * e tambem provedores autenticados por OAuth — a unica diferenca e' de onde vem
 * o Bearer token.
 */

// O OpenAI aceita `content` como string ou como lista de partes (visao). A lisa
// gerada por nos e' sempre do tipo certo; o tipo aqui reflete so o que o
// provedor espera.
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** Convertido na hora de montar a payload: lista de partes para visao. */
  [key: string]: unknown;
}

export function toOpenAIMessages(request: CompletionRequest): unknown[] {
  const messages: unknown[] = [{ role: 'system', content: request.system }];
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      for (const result of turn.toolResults ?? []) {
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: result.isError ? `ERRO: ${result.content}` : result.content,
        });
      }
      const images = turn.images ?? [];
      if (turn.text || images.length > 0) {
        const parts: unknown[] = [];
        if (turn.text) parts.push({ type: 'text', text: turn.text });
        for (const image of images) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
          });
        }
        messages.push({ role: 'user', content: parts });
      }
      continue;
    }
    const toolCalls = turn.toolCalls ?? [];
    messages.push({
      role: 'assistant',
      content: turn.text ?? null,
      tool_calls: toolCalls.length > 0
        ? toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          }))
        : undefined,
    });
  }
  return messages;
}

interface StreamAccumulator {
  text: string;
  /** Raciocinio do modelo, quando ele separa isso do conteudo. */
  reasoning: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Erro em banda: HTTP 200 com o problema dentro do proprio stream. */
  error?: { message: string; code?: number | string };
}

interface StreamChunk {
  /**
   * Agregadores como o OpenRouter respondem HTTP 200 e reportam a falha DENTRO
   * do stream: um frame com `error` no topo e `choices` vazio. Ignorar esse
   * frame faz a resposta terminar vazia e parecer sucesso — o pior modo de
   * falha possivel, porque nao aparece erro nenhum para o usuario.
   */
  error?: { message?: string; code?: number | string };
  choices?: {
    delta?: {
      content?: string | null;
      /**
       * Modelos de raciocinio mandam a linha de pensamento aqui, e o nome do
       * campo varia por provedor. Ler so `content` faz a resposta chegar vazia
       * quando o modelo coloca tudo no raciocinio — e ai o turno termina sem
       * nada na tela.
       */
      reasoning?: string | null;
      reasoning_content?: string | null;
      reasoning_text?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Aplica um chunk SSE ao acumulador. Exportado para teste. */
export function applyChunk(acc: StreamAccumulator, chunk: StreamChunk, onText?: (t: string) => void): void {
  if (chunk.error) {
    acc.error = {
      message: chunk.error.message ?? 'o provedor reportou um erro sem mensagem',
      code: chunk.error.code,
    };
  }
  const choice = chunk.choices?.[0];
  if (choice?.delta?.content) {
    acc.text += choice.delta.content;
    onText?.(choice.delta.content);
  }
  const raciocinio =
    choice?.delta?.reasoning ??
    choice?.delta?.reasoning_content ??
    choice?.delta?.reasoning_text;
  if (raciocinio) acc.reasoning += raciocinio;
  for (const delta of choice?.delta?.tool_calls ?? []) {
    const current = acc.toolCalls.get(delta.index) ?? { id: '', name: '', args: '' };
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.name += delta.function.name;
    if (delta.function?.arguments) current.args += delta.function.arguments;
    acc.toolCalls.set(delta.index, current);
  }
  if (choice?.finish_reason) acc.finishReason = choice.finish_reason;
  if (chunk.usage) {
    acc.usage = {
      inputTokens: chunk.usage.prompt_tokens ?? 0,
      outputTokens: chunk.usage.completion_tokens ?? 0,
    };
  }
}

/**
 * Traduz o status HTTP do provedor em classificacao.
 *
 * 402 e 404 sao configuracao da conta, nao defeito: credito acabou, modelo nao
 * existe, ou a politica de dados da conta nao casa com nenhum provedor (o caso
 * dos modelos `:free` do OpenRouter). Tratar isso como bug enche o tracker de
 * problema que so o dono da conta resolve.
 */
export function providerKindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 404) return 'unavailable';
  if (status === 408 || status === 429 || status >= 500) return 'rate-limit';
  return 'http';
}

/** Mapeia o codigo do erro em banda para a classificacao do modulo de erros. */
export function kindForStreamErrorCode(code: number | string | undefined): ProviderErrorKind {
  const numeric = typeof code === 'number' ? code : Number(code);
  if (!Number.isFinite(numeric)) return 'http';
  return providerKindForStatus(numeric);
}

export function finalizeToolCalls(acc: StreamAccumulator): ToolCall[] {
  return [...acc.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => {
      let input: Record<string, unknown> = {};
      try {
        input = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
      } catch {
        input = { __parseError: call.args };
      }
      return { id: call.id || `call_${index}`, name: call.name, input };
    });
}

export interface OpenAICompatibleOptions {
  id: string;
  label: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  baseUrl: string;
  /** Resolve o Bearer na hora da chamada (permite refresh de token OAuth). */
  getAuthToken: () => Promise<string>;
  extraHeaders?: Record<string, string>;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): AIProvider {
  return {
    id: options.id,
    label: options.label,
    model: options.model,
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const token = await options.getAuthToken();
      const endpoint = normalizeBaseUrl(options.baseUrl);

      let response: Response;
      try {
        response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...options.extraHeaders,
        },
        signal: request.signal,
        body: JSON.stringify({
          model: options.model,
          max_tokens: options.maxTokens,
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          stream: true,
          stream_options: { include_usage: true },
          messages: toOpenAIMessages(request),
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }
            : {}),
          }),
        });
            // ...
      } catch {
        throw new ProviderError('Erro de rede', 'network');
      }

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new ProviderError(
          `${options.label} respondeu ${response.status}: ${detail.slice(0, 300) || response.statusText}`,
          providerKindForStatus(response.status),
        );
      }
      return { text: '', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
