import type { ChatMessage, RepoId, RepoMap, RepoRef } from '../types';
import { assertRepoId } from '../storage';

/**
 * FIREWALL DE CONTEXTO
 *
 * Regra inegociavel do produto: uma conversa sobre o repositorio X nunca pode
 * ver, citar ou escrever em outro repositorio. Isso e' garantido em quatro
 * camadas independentes:
 *
 *   1. Armazenamento — chaves namespaced por repoId (ver `storage.ts`).
 *   2. Escopo — toda tool recebe um `RepoScope` imutavel; owner/name saem dali,
 *      nunca de argumento do modelo.
 *   3. Historico — as mensagens enviadas ao modelo sao filtradas por repoId.
 *   4. Canario — antes de cada request, o payload e' varrido atras do nome de
 *      qualquer OUTRO repositorio conectado; se aparecer, a chamada aborta.
 */

export class ContextIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextIsolationError';
  }
}

export interface RepoScope {
  readonly repoId: RepoId;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly repo: RepoRef;
}

export function createScope(repo: RepoRef): RepoScope {
  assertRepoId(repo.id);
  if (`${repo.owner}/${repo.name}` !== repo.id) {
    throw new ContextIsolationError(
      `Referencia inconsistente: id=${repo.id} mas owner/name=${repo.owner}/${repo.name}`,
    );
  }
  return Object.freeze({
    repoId: repo.id,
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    repo,
  });
}

export function assertScopedMap(scope: RepoScope, map: RepoMap): RepoMap {
  if (map.repoId !== scope.repoId) {
    throw new ContextIsolationError(
      `Mapa de ${map.repoId} nao pode ser usado na conversa de ${scope.repoId}`,
    );
  }
  return map;
}

/** Filtra o historico, descartando (em vez de vazar) qualquer mensagem alheia. */
export function scopedHistory(scope: RepoScope, messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.repoId === scope.repoId);
}

/**
 * Canario de vazamento: procura o nome completo de outros repositorios
 * conectados dentro do payload que sairia para o modelo. Comparacao por nome
 * completo (`owner/name`) — dois repos do mesmo dono nao geram falso positivo.
 */
export function assertNoForeignRepoLeak(
  scope: RepoScope,
  payload: string,
  connectedRepoIds: RepoId[],
): void {
  const haystack = payload.toLowerCase();
  for (const repoId of connectedRepoIds) {
    if (repoId === scope.repoId) continue;
    if (haystack.includes(repoId.toLowerCase())) {
      throw new ContextIsolationError(
        `Vazamento de contexto bloqueado: o prompt de ${scope.repoId} mencionava ${repoId}.`,
      );
    }
  }
}
