import type { Checkpoint, PendingFileChange, RepoRef } from '../types';
import {
  createBlob,
  createCommit,
  createRef,
  createTree,
  getBranchHeadSha,
  getCommit,
  updateRef,
  type TreeChange,
} from './client';

/**
 * Politica de escrita do Lovagit (definida com o usuario):
 *
 *   1. Antes de QUALQUER commit, cria-se uma branch de backup apontando para o
 *      HEAD atual da branch alvo (normalmente `main`).
 *   2. As alteracoes sao commitadas na propria branch alvo — porque o Lovable
 *      so enxerga a `main`.
 *   3. Para voltar uma versao, usa-se a branch de backup como referencia: um
 *      novo commit na `main` restaura a arvore do backup. Nada de force-push,
 *      o historico continua intacto e auditavel.
 */

export function backupBranchName(branch: string, date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const safeBranch = branch.replace(/[^A-Za-z0-9._/-]/g, '-');
  return `lovagit/backup/${safeBranch}/${stamp}`;
}

/** Normaliza e valida um caminho vindo do modelo. */
export function normalizeRepoPath(path: string): string {
  const trimmed = path.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (!trimmed) throw new Error('Caminho vazio');
  if (trimmed.includes('..')) throw new Error(`Caminho invalido (contem ".."): ${path}`);
  if (trimmed.startsWith('.git/')) throw new Error('Nao e permitido escrever dentro de .git');
  if (trimmed.length > 400) throw new Error('Caminho longo demais');
  return trimmed;
}

/**
 * Mensagem de commit derivada das alteracoes, para quando o modelo prepara
 * arquivos mas nao propoe uma mensagem. Serve como ponto de partida editavel —
 * melhor do que deixar uma string interna da interface virar historico do git.
 */
export function defaultCommitMessage(changes: PendingFileChange[]): string {
  const caminhos = changes.map((change) => normalizeRepoPath(change.path));
  const acoes = new Set(changes.map((change) => change.action));
  const verbo =
    acoes.size === 1 && acoes.has('create')
      ? 'adiciona'
      : acoes.size === 1 && acoes.has('delete')
        ? 'remove'
        : 'atualiza';

  if (caminhos.length === 1) return `chore: ${verbo} ${caminhos[0]}`;
  return [
    `chore: ${verbo} ${caminhos.length} arquivos`,
    '',
    ...caminhos.map((caminho) => `- ${caminho}`),
  ].join('\n');
}

export interface ApplyResult {
  checkpoint: Checkpoint;
  commitUrl: string;
  backupUrl: string;
}

async function createUniqueBackupBranch(
  repo: RepoRef,
  branch: string,
  sha: string,
): Promise<string> {
  const base = backupBranchName(branch);
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      await createRef(repo.owner, repo.name, candidate, sha);
      return candidate;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "Reference already exists" — tenta o proximo sufixo.
      if (!/already exists/i.test(message)) throw error;
    }
  }
  throw new Error('Nao foi possivel criar a branch de backup (nomes ja existentes)');
}

/**
 * Aplica um conjunto de alteracoes: backup -> blobs -> tree -> commit -> ref.
 * Falha sem efeito colateral destrutivo: se o `updateRef` nao for fast-forward
 * (alguem commitou na branch no meio do caminho), o commit fica orfao e a
 * branch alvo continua intacta.
 */
export async function applyChanges(
  repo: RepoRef,
  branch: string,
  changes: PendingFileChange[],
  message: string,
): Promise<ApplyResult> {
  if (changes.length === 0) throw new Error('Nenhuma alteracao para aplicar');

  const baseSha = await getBranchHeadSha(repo.owner, repo.name, branch);
  const baseCommit = await getCommit(repo.owner, repo.name, baseSha);
  const backupBranch = await createUniqueBackupBranch(repo, branch, baseSha);

  const treeChanges: TreeChange[] = [];
  for (const change of changes) {
    const path = normalizeRepoPath(change.path);
    if (change.action === 'delete') {
      treeChanges.push({ path, sha: null });
      continue;
    }
    const blobSha = await createBlob(repo.owner, repo.name, change.content ?? '');
    treeChanges.push({ path, sha: blobSha });
  }

  const treeSha = await createTree(repo.owner, repo.name, baseCommit.treeSha, treeChanges);
  const commitSha = await createCommit(repo.owner, repo.name, message, treeSha, [baseSha]);
  await updateRef(repo.owner, repo.name, branch, commitSha);

  const checkpoint: Checkpoint = {
    id: `cp_${commitSha.slice(0, 10)}`,
    repoId: repo.id,
    backupBranch,
    baseSha,
    commitSha,
    branch,
    message,
    files: changes.map((c) => ({ path: normalizeRepoPath(c.path), action: c.action })),
    createdAt: Date.now(),
  };

  return {
    checkpoint,
    commitUrl: `${repo.htmlUrl}/commit/${commitSha}`,
    backupUrl: `${repo.htmlUrl}/tree/${backupBranch}`,
  };
}

/**
 * Restaura o estado guardado em um checkpoint: cria um commit novo na branch
 * alvo com a arvore exata da branch de backup. O historico e' preservado, e a
 * propria restauracao vira um checkpoint (da para desfazer a desfeita).
 */
export async function restoreCheckpoint(
  repo: RepoRef,
  checkpoint: Checkpoint,
): Promise<ApplyResult> {
  const branch = checkpoint.branch;
  const currentSha = await getBranchHeadSha(repo.owner, repo.name, branch);
  if (currentSha === checkpoint.baseSha) {
    throw new Error('A branch ja esta no estado desse backup — nada a restaurar.');
  }

  const backupCommit = await getCommit(repo.owner, repo.name, checkpoint.baseSha);
  const safetyBranch = await createUniqueBackupBranch(repo, branch, currentSha);

  const message = [
    `revert: restaura ${branch} para o backup ${checkpoint.backupBranch}`,
    '',
    `Estado restaurado: ${checkpoint.baseSha}`,
    `Estado anterior a restauracao: ${currentSha} (backup em ${safetyBranch})`,
    `Checkpoint de origem: ${checkpoint.id} — ${checkpoint.message.split('\n')[0]}`,
  ].join('\n');

  const commitSha = await createCommit(repo.owner, repo.name, message, backupCommit.treeSha, [
    currentSha,
  ]);
  await updateRef(repo.owner, repo.name, branch, commitSha);

  return {
    checkpoint: {
      id: `cp_${commitSha.slice(0, 10)}`,
      repoId: repo.id,
      backupBranch: safetyBranch,
      baseSha: currentSha,
      commitSha,
      branch,
      message,
      files: checkpoint.files,
      createdAt: Date.now(),
      restoredFrom: checkpoint.id,
    },
    commitUrl: `${repo.htmlUrl}/commit/${commitSha}`,
    backupUrl: `${repo.htmlUrl}/tree/${safetyBranch}`,
  };
}
