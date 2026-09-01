import { getSecret, SecretNames } from '../vault';
import type { RateLimitInfo, RepoRef, TreeEntry } from '../types';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

let lastRateLimit: RateLimitInfo | null = null;
export function getLastRateLimit(): RateLimitInfo | null {
  return lastRateLimit;
}

/** Cache condicional por ETag: respostas 304 nao consomem cota de rate limit. */
const etagCache = new Map<string, { etag: string; data: unknown }>();

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Usa ETag/If-None-Match. So faz sentido em GETs idempotentes. */
  cache?: boolean;
  accept?: string;
  signal?: AbortSignal;
}

export async function githubRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await getSecret(SecretNames.githubPat);
  if (!token) throw new GitHubError('Token do GitHub nao configurado', 401, path);

  const url = path.startsWith('http') ? path : `${API}${path}`;
  const method = options.method ?? 'GET';
  const useCache = options.cache !== false && method === 'GET';
  const cached = useCache ? etagCache.get(url) : undefined;

  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (cached) headers['If-None-Match'] = cached.etag;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  const limit = Number(response.headers.get('x-ratelimit-limit'));
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(limit) && Number.isFinite(remaining)) {
    lastRateLimit = { limit, remaining, resetAt: reset * 1000 };
  }

  if (response.status === 304 && cached) return cached.data as T;

  if (!response.ok) {
    let body: unknown;
    let message = `${response.status} ${response.statusText}`;
    try {
      body = await response.json();
      const detail = (body as { message?: string })?.message;
      if (detail) message = detail;
    } catch {
      /* resposta sem corpo JSON */
    }
    if (response.status === 403 && lastRateLimit?.remaining === 0) {
      const at = new Date(lastRateLimit.resetAt).toLocaleTimeString();
      message = `Limite de requisicoes do GitHub atingido. Libera as ${at}.`;
    }
    throw new GitHubError(message, response.status, url, body);
  }

  const data = (await response.json()) as T;
  const etag = response.headers.get('etag');
  if (useCache && etag) etagCache.set(url, { etag, data });
  return data;
}

export interface GitHubUser {
  login: string;
  avatarUrl: string;
  name: string | null;
}

export async function getAuthenticatedUser(): Promise<GitHubUser> {
  const user = await githubRequest<{ login: string; avatar_url: string; name: string | null }>(
    '/user',
    { cache: false },
  );
  return { login: user.login, avatarUrl: user.avatar_url, name: user.name };
}

interface ApiRepo {
  full_name: string;
  owner: { login: string };
  name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
  pushed_at: string;
  description: string | null;
  archived: boolean;
}

function toRepoRef(repo: ApiRepo): RepoRef {
  return {
    id: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    defaultBranch: repo.default_branch,
    private: repo.private,
    htmlUrl: repo.html_url,
  };
}

export interface RepoSummary extends RepoRef {
  description: string | null;
  pushedAt: string;
  archived: boolean;
}

/** Lista os repositorios acessiveis pelo PAT, mais recentes primeiro. */
export async function listRepositories(maxPages = 4): Promise<RepoSummary[]> {
  const out: RepoSummary[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await githubRequest<ApiRepo[]>(
      `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`,
    );
    out.push(
      ...batch.map((repo) => ({
        ...toRepoRef(repo),
        description: repo.description,
        pushedAt: repo.pushed_at,
        archived: repo.archived,
      })),
    );
    if (batch.length < 100) break;
  }
  return out;
}

export async function getRepository(owner: string, name: string): Promise<RepoRef> {
  return toRepoRef(await githubRequest<ApiRepo>(`/repos/${owner}/${name}`));
}

export async function getBranchHeadSha(
  owner: string,
  name: string,
  branch: string,
): Promise<string> {
  const ref = await githubRequest<{ object: { sha: string } }>(
    `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`,
    { cache: false },
  );
  return ref.object.sha;
}

export async function getTree(
  owner: string,
  name: string,
  sha: string,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const tree = await githubRequest<{
    tree: { path: string; type: string; size?: number; sha: string }[];
    truncated: boolean;
  }>(`/repos/${owner}/${name}/git/trees/${sha}?recursive=1`);
  return {
    entries: tree.tree
      .filter((e) => e.type === 'blob' || e.type === 'tree')
      .map((e) => ({
        path: e.path,
        type: e.type as 'blob' | 'tree',
        size: e.size,
        sha: e.sha,
      })),
    truncated: tree.truncated,
  };
}

export async function getLanguages(owner: string, name: string): Promise<Record<string, number>> {
  try {
    return await githubRequest<Record<string, number>>(`/repos/${owner}/${name}/languages`);
  } catch {
    return {};
  }
}

function decodeBase64Utf8(value: string): string {
  const clean = value.replace(/\s/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
  size: number;
  truncatedBinary: boolean;
}

/** Le um arquivo. Blobs > 1 MB voltam sem `content` na Contents API, entao
 *  caimos na Blobs API, que aguenta ate 100 MB. */
export async function getFileContent(
  owner: string,
  name: string,
  path: string,
  ref: string,
): Promise<FileContent> {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const meta = await githubRequest<{
    type: string;
    content?: string;
    encoding?: string;
    sha: string;
    size: number;
  }>(`/repos/${owner}/${name}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);

  if (meta.type !== 'file') {
    throw new GitHubError(`${path} nao e' um arquivo`, 400, path);
  }

  if (meta.content && meta.encoding === 'base64') {
    return {
      path,
      content: decodeBase64Utf8(meta.content),
      sha: meta.sha,
      size: meta.size,
      truncatedBinary: false,
    };
  }

  const blob = await githubRequest<{ content: string; encoding: string; size: number }>(
    `/repos/${owner}/${name}/git/blobs/${meta.sha}`,
  );
  return {
    path,
    content: blob.encoding === 'base64' ? decodeBase64Utf8(blob.content) : blob.content,
    sha: meta.sha,
    size: blob.size,
    truncatedBinary: false,
  };
}

export interface CodeSearchHit {
  path: string;
  fragments: string[];
}

/** Busca de codigo restrita a UM repositorio (`repo:owner/name` embutido). */
export async function searchCode(
  owner: string,
  name: string,
  query: string,
  limit = 15,
): Promise<CodeSearchHit[]> {
  const q = `${query} repo:${owner}/${name}`;
  const result = await githubRequest<{
    items: { path: string; text_matches?: { fragment: string }[] }[];
  }>(`/search/code?q=${encodeURIComponent(q)}&per_page=${limit}`, {
    accept: 'application/vnd.github.text-match+json',
  });
  return result.items.map((item) => ({
    path: item.path,
    fragments: (item.text_matches ?? []).map((m) => m.fragment.trim()).slice(0, 3),
  }));
}

export async function listBranches(owner: string, name: string): Promise<string[]> {
  const branches = await githubRequest<{ name: string }[]>(
    `/repos/${owner}/${name}/branches?per_page=100`,
    { cache: false },
  );
  return branches.map((b) => b.name);
}

export async function createRef(
  owner: string,
  name: string,
  branch: string,
  sha: string,
): Promise<void> {
  await githubRequest(`/repos/${owner}/${name}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha },
  });
}

export async function updateRef(
  owner: string,
  name: string,
  branch: string,
  sha: string,
  force = false,
): Promise<void> {
  await githubRequest(`/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    body: { sha, force },
  });
}

export async function createBlob(
  owner: string,
  name: string,
  content: string,
): Promise<string> {
  const blob = await githubRequest<{ sha: string }>(`/repos/${owner}/${name}/git/blobs`, {
    method: 'POST',
    body: { content, encoding: 'utf-8' },
  });
  return blob.sha;
}

export interface TreeChange {
  path: string;
  /** `null` remove o arquivo da arvore. */
  sha: string | null;
  mode?: '100644' | '100755';
}

export async function createTree(
  owner: string,
  name: string,
  baseTree: string,
  changes: TreeChange[],
): Promise<string> {
  const tree = await githubRequest<{ sha: string }>(`/repos/${owner}/${name}/git/trees`, {
    method: 'POST',
    body: {
      base_tree: baseTree,
      tree: changes.map((change) => ({
        path: change.path,
        mode: change.mode ?? '100644',
        type: 'blob',
        sha: change.sha,
      })),
    },
  });
  return tree.sha;
}

export async function getCommit(
  owner: string,
  name: string,
  sha: string,
): Promise<{ sha: string; treeSha: string; message: string }> {
  const commit = await githubRequest<{ sha: string; tree: { sha: string }; message: string }>(
    `/repos/${owner}/${name}/git/commits/${sha}`,
  );
  return { sha: commit.sha, treeSha: commit.tree.sha, message: commit.message };
}

export async function createCommit(
  owner: string,
  name: string,
  message: string,
  treeSha: string,
  parents: string[],
): Promise<string> {
  const commit = await githubRequest<{ sha: string }>(`/repos/${owner}/${name}/git/commits`, {
    method: 'POST',
    body: { message, tree: treeSha, parents },
  });
  return commit.sha;
}
