import type { ToolCall } from '../types';
import { ProviderError, type AIProvider, type CompletionRequest, type CompletionResponse } from './types';

/**
 * Cliente para qualquer endpoint no formato OpenAI (`POST /chat/completions`):
 * OpenAI, Groq, OpenRouter, Together, Gemini via camada compativel, LM Studio,
 * e tambem provedores autenticados por OAuth — a unica diferenca e' de onde vem
 * o Bearer token.
 */

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export function toOpenAIMessages(request: CompletionRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: 'system', content: request.system }];
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      for (const result of turn.toolResults ?? []) {
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: result.isError ? `ERRO: ${result.content}` : result.content,
        });
      }
      if (turn.text) messages.push({ role: 'user', content: turn.text });
      continue;
    }
    const toolCalls = turn.toolCalls ?? [];
    messages.push({
      role: 'assistant',
      content: turn.text ?? null,
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          }
        : {}),
    });
  }
  return messages;
}

interface StreamAccumulator {
  text: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
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
  const choice = chunk.choices?.[0];
  if (choice?.delta?.content) {
    acc.text += choice.delta.content;
    onText?.(choice.delta.content);
  }
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
      const response = await fetch(normalizeBaseUrl(options.baseUrl), {
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

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new ProviderError(
          `${options.label} respondeu ${response.status}: ${detail.slice(0, 300) || response.statusText}`,
          response.status === 401 || response.status === 403
            ? 'auth'
            : response.status === 429 || response.status >= 500
              ? 'rate-limit'
              : 'http',
        );
      }

      const acc: StreamAccumulator = {
        text: '',
        toolCalls: new Map(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
      };

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              applyChunk(acc, JSON.parse(payload) as StreamChunk, request.onText);
            } catch {
              // Chunk malformado: ignora em vez de derrubar a conversa inteira.
            }
          }
        }
      }

      return {
        text: acc.text,
        toolCalls: finalizeToolCalls(acc),
        stopReason: acc.finishReason,
        usage: acc.usage,
      };
    },
  };
}
