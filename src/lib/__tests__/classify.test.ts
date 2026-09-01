import { describe, expect, it } from 'vitest';
import { classifyError } from '../telemetry/classify';
import { ContextIsolationError } from '../agent/isolation';
import { GitHubError } from '../github/client';
import { ProviderError } from '../ai/types';

describe('classifyError — o que NAO vira issue', () => {
  it('ignora cancelamento do usuario', () => {
    expect(classifyError(new DOMException('Cancelado', 'AbortError')).category).toBe('ignored');
  });

  it('trata queda de rede como passageiro', () => {
    expect(classifyError(new TypeError('Failed to fetch')).category).toBe('transient');
  });

  it('trata token invalido como configuracao do usuario', () => {
    expect(classifyError(new GitHubError('Bad credentials', 401, '/user')).category).toBe(
      'user-config',
    );
  });

  it('separa rate limit (passageiro) de falta de permissao (configuracao)', () => {
    const rateLimited = new GitHubError('Limite de requisicoes do GitHub atingido.', 403, '/x');
    const forbidden = new GitHubError('Resource not accessible by personal access token', 403, '/x');
    expect(classifyError(rateLimited).category).toBe('transient');
    expect(classifyError(forbidden).category).toBe('user-config');
  });

  it('trata 5xx e 409 como passageiros', () => {
    expect(classifyError(new GitHubError('boom', 502, '/x')).category).toBe('transient');
    expect(classifyError(new GitHubError('conflito', 409, '/x')).category).toBe('transient');
  });

  it('trata chave de IA invalida como configuracao', () => {
    expect(classifyError(new ProviderError('sem chave', 'auth')).category).toBe('user-config');
  });

  it('trata bloqueio do firewall por texto do usuario como esperado, nao defeito', () => {
    const blocked = new ContextIsolationError('citou outro repo', 'foreign-repo-user-input');
    expect(classifyError(blocked).category).toBe('user-config');
  });
});

describe('classifyError — o que vira issue', () => {
  it('marca vazamento de contexto interno como defeito da extensao', () => {
    const leak = new ContextIsolationError('vazou', 'foreign-repo-internal');
    const result = classifyError(leak);
    expect(result.category).toBe('bug');
    expect(result.origin).toBe('extension');
  });

  it('marca 422 do GitHub como defeito da extensao (payload nosso)', () => {
    const result = classifyError(new GitHubError('Invalid request', 422, '/x'));
    expect(result.category).toBe('bug');
    expect(result.origin).toBe('extension');
    expect(result.status).toBe(422);
  });

  it('marca resposta fora do contrato do provedor como defeito de integracao', () => {
    const result = classifyError(new ProviderError('sem access_token', 'protocol'));
    expect(result.category).toBe('bug');
    expect(result.origin).toBe('integration');
  });

  it('marca excecao nao tratada como defeito da extensao', () => {
    const result = classifyError(new TypeError("Cannot read properties of undefined"));
    expect(result.category).toBe('bug');
    expect(result.origin).toBe('extension');
    expect(result.name).toBe('TypeError');
  });

  it('lida com valor nao-Error lancado', () => {
    const result = classifyError('string solta');
    expect(result.category).toBe('bug');
    expect(result.name).toBe('UnknownThrownValue');
  });
});
