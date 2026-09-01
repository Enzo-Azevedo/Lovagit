import type { ToolCall, ToolResult } from '../types';

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema do input (draft 2020-12, subset suportado por todos provedores). */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** Turno neutro de provedor. Um turno de usuario pode carregar resultados de
 *  tools do turno anterior; um turno de assistente carrega texto e/ou chamadas. */
export interface ProviderTurn {
  role: 'user' | 'assistant';
  text?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface CompletionRequest {
  system: string;
  turns: ProviderTurn[];
  tools: ToolSchema[];
  signal?: AbortSignal;
  /** Streaming incremental de texto para a UI. */
  onText?: (delta: string) => void;
}

export interface CompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AIProvider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
