import { describe, expect, it } from 'vitest';
import {
  assertNoForeignRepoLeak,
  assertScopedMap,
  createScope,
  scopedHistory,
} from '../agent/isolation';
import type { ChatMessage, RepoMap, RepoRef } from '../types';

const repo: RepoRef = {
  id: 'acme/site',
  owner: 'acme',
  name: 'site',
  defaultBranch: 'main',
  private: false,
  htmlUrl: 'https://github.com/acme/site',
};

function chat(repoId: string, content: string): ChatMessage {
  return { id: content, repoId, role: 'user', content, createdAt: 0 };
}

describe('createScope', () => {
  it('congela o escopo derivado do repositorio', () => {
    const scope = createScope(repo);
    expect(scope.repoId).toBe('acme/site');
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it('rejeita referencia com id inconsistente com owner/name', () => {
    expect(() => createScope({ ...repo, name: 'outro' })).toThrow(/inconsistente/);
  });

  it('rejeita repoId fora do formato owner/name', () => {
    expect(() => createScope({ ...repo, id: 'sozinho' })).toThrow(/repoId invalido/);
  });
});

describe('scopedHistory', () => {
  it('descarta mensagens de outros repositorios', () => {
    const scope = createScope(repo);
    const history = [
      chat('acme/site', 'minha'),
      chat('acme/api', 'de outro repo'),
      chat('acme/site', 'minha tambem'),
    ];
    expect(scopedHistory(scope, history).map((m) => m.content)).toEqual(['minha', 'minha tambem']);
  });
});

describe('assertScopedMap', () => {
  it('recusa mapa de outro repositorio', () => {
    const scope = createScope(repo);
    const map = { repoId: 'acme/api' } as RepoMap;
    expect(() => assertScopedMap(scope, map)).toThrow(/nao pode ser usado/);
  });
});

describe('assertNoForeignRepoLeak', () => {
  const scope = createScope(repo);
  const connected = ['acme/site', 'acme/api', 'outra-org/app'];

  it('passa quando o payload so cita o proprio repositorio', () => {
    expect(() =>
      assertNoForeignRepoLeak(scope, 'Ajuste o header de acme/site em src/App.tsx', connected),
    ).not.toThrow();
  });

  it('bloqueia quando outro repositorio conectado aparece no payload', () => {
    expect(() =>
      assertNoForeignRepoLeak(scope, 'copie o componente de acme/api para ca', connected),
    ).toThrow(/Vazamento de contexto bloqueado/);
  });

  it('e insensivel a caixa', () => {
    expect(() => assertNoForeignRepoLeak(scope, 'veja Outra-Org/App', connected)).toThrow();
  });

  it('nao gera falso positivo com o mesmo owner', () => {
    expect(() =>
      assertNoForeignRepoLeak(scope, 'o owner acme mantem varios projetos', connected),
    ).not.toThrow();
  });
});
