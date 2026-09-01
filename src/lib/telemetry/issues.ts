import { githubRequest } from '../github/client';
import type { RepoId } from '../types';
import { LABELS } from './types';

/**
 * Cliente da Issues API para o repositorio de destino dos relatorios.
 *
 * Dois detalhes da API que moldam este arquivo:
 *  - labels **nao** sao criadas sozinhas ao abrir um issue; e preciso criar
 *    antes, no endpoint de labels;
 *  - quem nao tem push access no repositorio tem as labels descartadas em
 *    silencio na criacao. Por isso a prioridade tambem vai escrita no corpo.
 */

const LABEL_DEFINITIONS = [
  {
    name: LABELS.highPriority,
    color: 'b60205',
    description: 'Resolver primeiro — erro originado na propria extensao.',
  },
  {
    name: LABELS.extensionError,
    color: 'd93f0b',
    description: 'Relatorio automatico: defeito no codigo da extensao.',
  },
  {
    name: LABELS.integrationError,
    color: 'fbca04',
    description: 'Relatorio automatico: falha de integracao com servico externo.',
  },
];

function splitRepoId(repoId: RepoId): { owner: string; name: string } {
  const [owner, name] = repoId.split('/');
  return { owner, name };
}

/** Cria as labels que faltam. Um 422 aqui significa "ja existe" — segue o jogo. */
export async function ensureLabels(targetRepoId: RepoId): Promise<void> {
  const { owner, name } = splitRepoId(targetRepoId);
  for (const label of LABEL_DEFINITIONS) {
    try {
      await githubRequest(`/repos/${owner}/${name}/labels`, {
        method: 'POST',
        body: label,
      });
    } catch {
      // Ja existe, ou o token nao tem push access: nos dois casos seguimos sem
      // label — a prioridade tambem esta escrita no corpo do issue.
    }
  }
}

export function fingerprintMarker(fingerprint: string): string {
  return `lovagit-fp:${fingerprint}`;
}

export interface ExistingIssue {
  number: number;
  url: string;
  state: 'open' | 'closed';
}

/** Procura um issue ja aberto para a mesma falha, pelo marcador no corpo. */
export async function findIssueByFingerprint(
  targetRepoId: RepoId,
  fingerprint: string,
): Promise<ExistingIssue | null> {
  const query = `repo:${targetRepoId} is:issue "${fingerprintMarker(fingerprint)}"`;
  const result = await githubRequest<{
    items: { number: number; html_url: string; state: string }[];
  }>(`/search/issues?q=${encodeURIComponent(query)}&per_page=5`, { cache: false });

  const match = result.items.find((item) => item.state === 'open') ?? result.items[0];
  if (!match) return null;
  return {
    number: match.number,
    url: match.html_url,
    state: match.state === 'closed' ? 'closed' : 'open',
  };
}

export interface CreatedIssue {
  number: number;
  url: string;
  appliedLabels: string[];
}

export async function createIssue(
  targetRepoId: RepoId,
  input: { title: string; body: string; labels: string[] },
): Promise<CreatedIssue> {
  const { owner, name } = splitRepoId(targetRepoId);
  const issue = await githubRequest<{
    number: number;
    html_url: string;
    labels: { name: string }[];
  }>(`/repos/${owner}/${name}/issues`, {
    method: 'POST',
    body: { title: input.title, body: input.body, labels: input.labels },
  });
  return {
    number: issue.number,
    url: issue.html_url,
    appliedLabels: (issue.labels ?? []).map((label) => label.name),
  };
}

export async function commentOnIssue(
  targetRepoId: RepoId,
  issueNumber: number,
  body: string,
): Promise<string> {
  const { owner, name } = splitRepoId(targetRepoId);
  const comment = await githubRequest<{ html_url: string }>(
    `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
    { method: 'POST', body: { body } },
  );
  return comment.html_url;
}

/** Reabre um issue fechado quando a mesma falha volta a acontecer. */
export async function reopenIssue(targetRepoId: RepoId, issueNumber: number): Promise<void> {
  const { owner, name } = splitRepoId(targetRepoId);
  await githubRequest(`/repos/${owner}/${name}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: { state: 'open' },
  });
}
