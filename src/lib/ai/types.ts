import type { ToolCall, ToolResult, TurnImage } from '../types';

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
  /** Imagens do turno do usuario. So no turno em que foram anexadas. */
  images?: TurnImage[];
}

export interface CompletionRequest {
  system: string;
  turns: ProviderTurn[];
  tools: ToolSchema[];
  signal?: AbortSignal;
  /** Streaming incremental de texto para a UI. */
  onText?: (delta: string) => void;
  /**
   * Streaming incremental do raciocinio. Serve para a UI mostrar que o modelo
   * esta trabalhando durante a fase de pensamento, que em modelo lento e o
   * trecho em que a conversa parece travada.
   */
  onReasoning?: (delta: string) => void;
}

export interface CompletionResponse {
  text: string;
  /** Raciocinio separado do conteudo, quando o modelo devolve os dois. */
  reasoning?: string;
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

/** Classificacao da falha, para o modulo de erros nao ter que adivinhar por
 *  regex em cima da mensagem. */
export type ProviderErrorKind =
  /** Credencial invalida ou ausente — configuracao do usuario. */
  | 'auth'
  /** Cota estourada — passageiro. */
  | 'rate-limit'
  /** Resposta HTTP inesperada do provedor. */
  | 'http'
  /** Conexao nao estabelecida ou interrompida — passageiro, nao e defeito. */
  | 'network'
  /**
   * Modelo ou endpoint indisponivel para esta conta: modelo inexistente, sem
   * credito, ou politica de dados da conta bloqueando os provedores. E
   * configuracao do usuario, nao defeito da extensao.
   */
  | 'unavailable'
  /** Resposta fora do contrato esperado — provavel defeito de integracao. */
  | 'protocol';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind = 'protocol',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
