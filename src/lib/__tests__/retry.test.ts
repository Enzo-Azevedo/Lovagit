import { describe, expect, it } from 'vitest';
import { RETRY_DELAY_SECONDS, shouldAutoRetry } from '../agent/retry';
import { ContextIsolationError } from '../agent/isolation';
import { GitHubError } from '../github/client';
import { ProviderError } from '../ai/types';

const base = { enabled: true, committed: false };

/** O 504 de idle timeout do OpenRouter chega como erro em banda do stream. */
const idleTimeout = new ProviderError(
  'Provedor interrompeu a geracao: Upstream idle timeout exceeded (codigo 504)',
  'rate-limit',
);

describe('shouldAutoRetry', () => {
  it('espera 5 segundos, como combinado', () => {
    expect(RETRY_DELAY_SECONDS).toBe(5);
  });

  it('reenvia o caso que motivou a opcao: idle timeout do provedor', () => {
    expect(shouldAutoRetry({ ...base, error: idleTimeout })).toBe(true);
  });

  it('reenvia queda de conexao', () => {
    expect(shouldAutoRetry({ ...base, error: new ProviderError('caiu', 'network') })).toBe(true);
    expect(shouldAutoRetry({ ...base, error: new TypeError('Failed to fetch') })).toBe(true);
  });

  it('fica desligado por padrao — sem a opcao, nada e reenviado', () => {
    expect(shouldAutoRetry({ ...base, enabled: false, error: idleTimeout })).toBe(false);
  });

  it('nao reenvia o que daria no mesmo na segunda tentativa', () => {
    const inuteis = [
      new ProviderError('chave invalida', 'auth'),
      new ProviderError('modelo inexistente', 'unavailable'),
      new ProviderError('resposta fora do contrato', 'protocol'),
      new ContextIsolationError('vazamento de contexto'),
      new GitHubError('payload recusado', 422, 'https://api.github.com/repos/o/r/git/trees'),
    ];
    for (const erro of inuteis) {
      expect(shouldAutoRetry({ ...base, error: erro })).toBe(false);
    }
  });

  it('nao reenvia cancelamento do usuario', () => {
    const abortado = new DOMException('Cancelado', 'AbortError');
    expect(shouldAutoRetry({ ...base, error: abortado })).toBe(false);
  });

  it('nao tem teto de tentativas: a falha do proprio reenvio agenda o proximo', () => {
    // Provedor gratuito cai por minutos seguidos. Desistir na segunda tentativa
    // devolvia o usuario para a tela parada que a opcao existe para evitar.
    for (let tentativa = 1; tentativa <= 50; tentativa++) {
      expect(shouldAutoRetry({ ...base, error: idleTimeout })).toBe(true);
    }
  });

  it('nunca reenvia depois de um commit, para nao repetir trabalho ja gravado', () => {
    expect(shouldAutoRetry({ ...base, committed: true, error: idleTimeout })).toBe(false);
  });
});
