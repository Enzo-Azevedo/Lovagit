import { getSecret, SecretNames } from '../vault';

/**
 * Repositorio da PROPRIA extensao. Nao tem a ver com os repositorios que o
 * usuario conecta: aqui se olha de onde baixar a versao nova do Lovagit.
 */
export const EXTENSION_REPO = 'Enzo-Azevedo/Lovagit';

/**
 * A release rolante: sempre o ultimo build da `main`. Como o numero de versao
 * so muda quando alguem o incrementa, esta tag pode carregar a MESMA versao ja
 * instalada — por isso o que se compara aqui e' o commit, nao a versao.
 */
export const LATEST_TAG = 'latest';

/** O MV3 proibe codigo remoto, entao a extensao nao se atualiza sozinha: o
 *  maximo honesto e' apontar o download. Reconsultar a cada abertura do painel
 *  so gastaria cota. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const CACHE_KEY = 'extension:latest-build';

export interface LatestBuild {
  /** Titulo da release, ex.: "Build da main (a39f224)". */
  name: string;
  /** Commit curto do build, extraido do titulo ou das notas. */
  commit: string;
  /** Versao do manifest anunciada nas notas da release. */
  version: string | null;
  /** URL direta do zip. */
  downloadUrl: string;
  sizeBytes: number;
  publishedAt: string;
  /** Pagina da release, para quem preferir ver antes de baixar. */
  htmlUrl: string;
  /** Quando esta resposta foi buscada — usada pelo cache. */
  fetchedAt: number;
}

interface ApiRelease {
  name?: string | null;
  body?: string | null;
  html_url: string;
  published_at: string;
  assets?: { name: string; browser_download_url: string; size: number }[];
}

/** Versao instalada, lida do proprio manifest. */
export function installedVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Extrai o commit curto. O titulo da release tem a forma
 * `Build da main (a39f224)`; as notas trazem o SHA completo.
 */
export function parseCommit(release: { name?: string | null; body?: string | null }): string {
  const doTitulo = /\(([0-9a-f]{7,40})\)/i.exec(release.name ?? '');
  if (doTitulo) return doTitulo[1].slice(0, 7);
  const dasNotas = /Commit:\s*([0-9a-f]{7,40})/i.exec(release.body ?? '');
  return dasNotas ? dasNotas[1].slice(0, 7) : '';
}

/** As notas do build anunciam a versao do manifest. */
export function parseVersion(body: string | null | undefined): string | null {
  const encontrada = /Versao do manifest:\s*([0-9]+\.[0-9]+\.[0-9]+)/i.exec(body ?? '');
  return encontrada ? encontrada[1] : null;
}

function toLatestBuild(release: ApiRelease): LatestBuild {
  const zip =
    release.assets?.find((asset) => asset.name.endsWith('.zip')) ?? release.assets?.[0] ?? null;
  if (!zip) throw new Error('A release do build da main nao tem zip publicado.');

  return {
    name: release.name ?? LATEST_TAG,
    commit: parseCommit(release),
    version: parseVersion(release.body),
    downloadUrl: zip.browser_download_url,
    sizeBytes: zip.size,
    publishedAt: release.published_at,
    htmlUrl: release.html_url,
    fetchedAt: Date.now(),
  };
}

async function readCache(): Promise<LatestBuild | null> {
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    const build = stored[CACHE_KEY] as LatestBuild | undefined;
    if (!build) return null;
    return Date.now() - build.fetchedAt < CACHE_TTL_MS ? build : null;
  } catch {
    return null;
  }
}

/**
 * Busca o ultimo build publicado da `main`.
 *
 * O repositorio e' publico, entao a chamada funciona sem token — o que importa,
 * porque quem ainda nao configurou o PAT tambem precisa conseguir atualizar a
 * extensao. Com token, so se ganha cota.
 */
export async function fetchLatestBuild(options: { force?: boolean } = {}): Promise<LatestBuild> {
  if (!options.force) {
    const cache = await readCache();
    if (cache) return cache;
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = await getSecret(SecretNames.githubPat).catch(() => null);
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(
    `https://api.github.com/repos/${EXTENSION_REPO}/releases/tags/${LATEST_TAG}`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(`GitHub respondeu ${response.status} ao buscar o build da main.`);
  }

  const build = toLatestBuild((await response.json()) as ApiRelease);
  await chrome.storage.local.set({ [CACHE_KEY]: build }).catch(() => undefined);
  return build;
}

/**
 * O build publicado e' diferente do que esta rodando aqui?
 *
 * Compara COMMIT, nao versao: a release rolante reaponta a cada push na `main`,
 * mantendo o mesmo numero de versao na maior parte das vezes. Sem o commit do
 * build instalado (o caso de quem carregou a pasta descompactada), sobra a
 * versao — e no empate a resposta e' "nao da para saber", nunca um falso "ha
 * novidade" que apareceria para sempre.
 */
export function isNewerBuild(build: LatestBuild, installed = installedVersion()): boolean {
  return build.version !== null && build.version !== installed;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Abre o download numa guia nova. */
export async function openDownload(url: string): Promise<void> {
  try {
    await chrome.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}
