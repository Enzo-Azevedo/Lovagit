import { ContextIsolationError } from '../agent/isolation';
import { GitHubError } from '../github/client';
import { McpError } from '../mcp/types';
import { ProviderError } from '../ai/types';
import type { ErrorCategory, ErrorOrigin } from './types';

export interface Classification {
  origin: ErrorOrigin;
  category: ErrorCategory;
  name: string;
  status?: number;
  /** Explica em uma linha por que caiu nessa categoria — vai no corpo do issue. */
  reason: string;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

/**
 * `fetch` e a leitura de um stream rejeitam com TypeError quando a rede cai ou
 * a origem nao foi permitida. As mensagens variam por navegador e por momento
 * da falha — o Chrome usa "Failed to fetch" na requisicao e "network error"
 * quando o stream e interrompido no meio.
 */
function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /failed to fetch|network\s*error|load failed|network request failed|connection closed/i.test(
      error.message,
    )
  );
}

/**
 * Decide o destino do erro. Só `category: 'bug'` vira issue — configuracao do
 * usuario e falha passageira ficam na interface, senao o tracker vira lixeira e
 * o defeito de verdade some no meio.
 */
export function classifyError(error: unknown): Classification {
  if (isAbort(error)) {
    return {
      origin: 'extension',
      category: 'ignored',
      name: 'AbortError',
      reason: 'Operacao cancelada pelo usuario.',
    };
  }

  if (isNetworkFailure(error)) {
    return {
      origin: 'integration',
      category: 'transient',
      name: 'NetworkError',
      reason: 'Falha de rede ou origem sem permissao de host.',
    };
  }

  if (error instanceof ContextIsolationError) {
    if (error.kind === 'foreign-repo-user-input') {
      return {
        origin: 'extension',
        category: 'user-config',
        name: 'ContextIsolationError',
        reason: 'Firewall de contexto barrou uma mensagem que citava outro repositorio.',
      };
    }
    return {
      origin: 'extension',
      category: 'bug',
      name: 'ContextIsolationError',
      reason: 'Contexto de outro repositorio entrou no prompt por construcao — defeito grave.',
    };
  }

  if (error instanceof McpError) {
    if (error.kind === 'unauthorized') {
      return {
        origin: 'integration',
        category: 'user-config',
        name: 'McpError',
        reason: 'Servidor MCP exige autorizacao ou recusou a credencial.',
      };
    }
    if (error.kind === 'transport' || error.kind === 'session-expired') {
      return {
        origin: 'integration',
        category: 'transient',
        name: 'McpError',
        reason: 'Falha de transporte ou sessao expirada no servidor MCP.',
      };
    }
    return {
      origin: 'integration',
      category: 'bug',
      name: 'McpError',
      reason: 'Servidor MCP respondeu fora do protocolo.',
    };
  }

  if (error instanceof GitHubError) {
    const status = error.status;
    if (status === 401) {
      return {
        origin: 'integration',
        category: 'user-config',
        name: 'GitHubError',
        status,
        reason: 'Token do GitHub invalido ou expirado.',
      };
    }
    if (status === 403) {
      const rateLimited = /limite de requisicoes|rate limit/i.test(error.message);
      return {
        origin: 'integration',
        category: rateLimited ? 'transient' : 'user-config',
        name: 'GitHubError',
        status,
        reason: rateLimited
          ? 'Rate limit do GitHub atingido.'
          : 'Token sem permissao para esta operacao.',
      };
    }
    if (status === 404) {
      return {
        origin: 'integration',
        category: 'user-config',
        name: 'GitHubError',
        status,
        reason: 'Recurso inexistente ou fora do escopo do token.',
      };
    }
    if (status === 409) {
      return {
        origin: 'integration',
        category: 'transient',
        name: 'GitHubError',
        status,
        reason: 'Conflito de referencia — a branch mudou durante a operacao.',
      };
    }
    if (status === 429 || status >= 500) {
      return {
        origin: 'integration',
        category: 'transient',
        name: 'GitHubError',
        status,
        reason: 'Indisponibilidade temporaria do GitHub.',
      };
    }
    // 422 e afins: a API recusou o payload que NOS montamos.
    return {
      origin: 'extension',
      category: 'bug',
      name: 'GitHubError',
      status,
      reason: 'A API do GitHub recusou uma requisicao montada pela extensao.',
    };
  }

  if (error instanceof ProviderError) {
    if (error.kind === 'auth') {
      return {
        origin: 'integration',
        category: 'user-config',
        name: 'ProviderError',
        reason: 'Credencial do provedor de IA invalida ou ausente.',
      };
    }
    if (error.kind === 'rate-limit') {
      return {
        origin: 'integration',
        category: 'transient',
        name: 'ProviderError',
        reason: 'Cota do provedor de IA atingida.',
      };
    }
    if (error.kind === 'unavailable') {
      return {
        origin: 'integration',
        category: 'user-config',
        name: 'ProviderError',
        reason:
          'Modelo ou endpoint indisponivel para esta conta (credito, modelo inexistente ' +
          'ou politica de dados do provedor).',
      };
    }
    if (error.kind === 'network') {
      return {
        origin: 'integration',
        category: 'transient',
        name: 'ProviderError',
        reason: 'Conexao com o provedor nao estabelecida ou interrompida.',
      };
    }
    return {
      origin: 'integration',
      category: 'bug',
      name: 'ProviderError',
      reason:
        error.kind === 'protocol'
          ? 'Resposta do provedor fora do contrato esperado.'
          : 'Resposta HTTP inesperada do provedor de IA.',
    };
  }

  if (error instanceof Error) {
    return {
      origin: 'extension',
      category: 'bug',
      name: error.name || 'Error',
      reason: 'Excecao nao tratada no codigo da extensao.',
    };
  }

  return {
    origin: 'extension',
    category: 'bug',
    name: 'UnknownThrownValue',
    reason: 'Valor nao-Error lancado pelo codigo da extensao.',
  };
}
