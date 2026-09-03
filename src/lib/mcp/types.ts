import type { RepoId } from '../types';

/** Versao do protocolo que pedimos no handshake. O servidor pode responder com
 *  outra (mais nova ou mais antiga) — isso e negociacao normal, nao erro. */
export const PREFERRED_PROTOCOL_VERSION = '2025-11-25';

export interface McpServerConfig {
  id: string;
  label: string;
  /** Endpoint Streamable HTTP do servidor, ex.: https://exemplo.com/mcp */
  url: string;
  /** Repositorios onde as ferramentas deste servidor ficam disponiveis.
   *  Vazio = nenhum. Nunca "todos" por omissao: isolamento e o padrao. */
  enabledRepoIds: RepoId[];
  /** Ferramentas descobertas no ultimo `tools/list`. */
  tools: McpToolInfo[];
  /** Ferramentas desabilitadas manualmente pelo usuario. */
  disabledTools: string[];
  lastConnectedAt?: number;
  lastError?: string;
  /** Preenchido apos registro dinamico (RFC 7591) ou informado a mao. */
  clientId?: string;
  /** Marca que o servidor exigiu OAuth. */
  requiresAuth?: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly serverId: string,
    /**
     * `unauthorized` dispara o fluxo OAuth; `session-expired` reconecta;
     * `needs-permission` pede um clique para liberar a origem em `origin`.
     */
    readonly kind:
      | 'unauthorized'
      | 'session-expired'
      | 'protocol'
      | 'transport'
      | 'needs-permission' = 'protocol',
    /**
     * Origem que falta liberar, quando `kind` e' `needs-permission`.
     *
     * Nao da para pedir essa permissao no meio do fluxo: o Chrome exige o gesto
     * do usuario, e a essa altura ele ja acabou. Entao o erro sobe carregando a
     * origem, e a interface transforma isso num botao — o proximo clique e' o
     * gesto que faltava.
     */
    readonly origin?: string,
  ) {
    super(message);
    this.name = 'McpError';
  }
}
