import type { RepoId } from '../types';

/**
 * O que a memoria guarda. Sao apenas fatos e intencoes destilados — nunca o
 * transcrito bruto da conversa, que e' o que faria a memoria competir com a
 * janela de contexto do modelo em vez de ajudar.
 */
export type MemoryKind =
  /** Algo que o usuario pediu. */
  | 'request'
  /** Algo que ficou combinado ou recusado, registrado pelo modelo. */
  | 'decision'
  /** Alteracao efetivamente aplicada no repositorio (commit). */
  | 'action';

/**
 * Nivel de compressao. A memoria nunca some: ela perde resolucao, do passado
 * distante para o recente.
 * - `0`: completa, com o detalhe verbatim;
 * - `1`: so a linha de resumo, sem o detalhe;
 * - `2`: varias entradas fundidas numa linha contada.
 */
export type MemoryLevel = 0 | 1 | 2;

export interface MemoryEntry {
  id: string;
  /** Namespacing por repositorio: uma entrada NUNCA cruza para outro chat. */
  repoId: RepoId;
  kind: MemoryKind;
  /** Uma linha. E o que sobrevive a toda compressao e o que entra no prompt. */
  summary: string;
  /** Detalhe verbatim. Primeiro a sair quando a memoria precisa encolher. */
  detail?: string;
  refs?: { paths?: string[]; commitSha?: string };
  createdAt: number;
  /** Fim do intervalo coberto, quando a entrada e' uma fusao. */
  untilAt?: number;
  level: MemoryLevel;
  /** Quantas entradas originais esta linha representa. */
  mergedCount?: number;
}

export interface MemoryUsage {
  bytes: number;
  budgetBytes: number;
  entries: number;
  /** Bytes por repositorio, do maior para o menor. */
  byRepo: { repoId: RepoId; bytes: number; entries: number }[];
}
