import { assertRepoId } from '../storage';
import type { RepoPlatformLink } from './prompt';
import type { RepoId } from '../types';
import { deleteSecret, getSecret, SecretNames, setSecret } from '../vault';
import {
  PLATFORMS,
  platformForMcpUrl,
  type PlatformConnection,
  type PlatformId,
  type PlatformProject,
} from './types';

/**
 * Conexoes de plataforma: token no cofre, estado em claro.
 *
 * O token nunca encosta em `chrome.storage.local`, que e' texto puro. O que
 * fica la e' so o suficiente para desenhar a tela — se ha token, quando foi
 * testado pela ultima vez e como foi.
 */

const KEY = 'platforms:connections';
const LINKS_KEY = 'platforms:links';

export async function getPlatformConnections(): Promise<PlatformConnection[]> {
  const stored = await chrome.storage.local.get(KEY);
  const salvas = (stored[KEY] as PlatformConnection[] | undefined) ?? [];
  // A lista sai sempre completa, na ordem das definicoes: a tela mostra toda
  // plataforma conhecida, com ou sem token.
  return PLATFORMS.map(
    (platform) =>
      salvas.find((conexao) => conexao.id === platform.id) ?? { id: platform.id, hasToken: false },
  );
}

async function writeConnections(conexoes: PlatformConnection[]): Promise<PlatformConnection[]> {
  await chrome.storage.local.set({ [KEY]: conexoes });
  return conexoes;
}

export async function updatePlatformConnection(
  id: PlatformId,
  patch: Partial<PlatformConnection>,
): Promise<PlatformConnection[]> {
  const conexoes = await getPlatformConnections();
  return writeConnections(
    conexoes.map((conexao) => (conexao.id === id ? { ...conexao, ...patch } : conexao)),
  );
}

export async function setPlatformToken(id: PlatformId, token: string): Promise<boolean> {
  const limpo = token.trim();
  if (!limpo) {
    await deleteSecret(SecretNames.platformToken(id));
    await updatePlatformConnection(id, {
      hasToken: false,
      lastCheck: undefined,
      lastCheckedAt: undefined,
      lastError: undefined,
    });
    return false;
  }
  await setSecret(SecretNames.platformToken(id), limpo);
  await updatePlatformConnection(id, { hasToken: true, lastError: undefined });
  return true;
}

export async function getPlatformToken(id: PlatformId): Promise<string | null> {
  // Token so de espacos e' o mesmo que token nenhum: `Bearer   ` rende um 401
  // que fala de credencial ausente, mandando procurar o problema no lugar errado.
  const limpo = (await getSecret(SecretNames.platformToken(id)))?.trim();
  return limpo ? limpo : null;
}

/**
 * Token de plataforma que serve para este servidor MCP.
 *
 * E' o que evita cadastrar a mesma credencial duas vezes: quem salvou o token do
 * Supabase em "Conexoes" nao precisa repeti-lo no servidor `mcp.supabase.com`.
 */
export async function platformTokenForMcpUrl(url: string): Promise<string | null> {
  const plataforma = platformForMcpUrl(url);
  return plataforma ? getPlatformToken(plataforma.id) : null;
}

/**
 * Vinculo repositorio -> projeto.
 *
 * Guardado por plataforma e por repositorio, e lido sempre com o repositorio em
 * mao: nao existe funcao que devolva "o projeto" sem dizer de quem. E' o mesmo
 * desenho da memoria — a estrutura torna dificil vazar de um chat para outro.
 */
export async function getPlatformLinks(): Promise<Record<string, Record<string, string>>> {
  const stored = await chrome.storage.local.get(LINKS_KEY);
  return (stored[LINKS_KEY] as Record<string, Record<string, string>> | undefined) ?? {};
}

/** `null` quando o repositorio nao tem projeto escolhido — nunca um chute. */
export async function getRepoProjectRef(
  platformId: PlatformId,
  repoId: RepoId,
): Promise<string | null> {
  assertRepoId(repoId);
  const links = await getPlatformLinks();
  return links[platformId]?.[repoId] ?? null;
}

/** Passar `null` desfaz o vinculo. */
export async function setRepoProjectRef(
  platformId: PlatformId,
  repoId: RepoId,
  ref: string | null,
): Promise<void> {
  assertRepoId(repoId);
  const links = await getPlatformLinks();
  const daPlataforma = { ...(links[platformId] ?? {}) };
  if (ref) daPlataforma[repoId] = ref;
  else delete daPlataforma[repoId];
  await chrome.storage.local.set({ [LINKS_KEY]: { ...links, [platformId]: daPlataforma } });
}

/** Tira o repositorio de todos os vinculos — usado ao desconectar um repo. */
export async function pruneRepoFromLinks(repoId: RepoId): Promise<void> {
  const links = await getPlatformLinks();
  const limpo = Object.fromEntries(
    Object.entries(links).map(([plataforma, mapa]) => {
      const copia = { ...mapa };
      delete copia[repoId];
      return [plataforma, copia];
    }),
  );
  await chrome.storage.local.set({ [LINKS_KEY]: limpo });
}

/**
 * O projeto DESTE repositorio, pronto para o system prompt.
 *
 * Devolve o objeto inteiro (nome junto do ref) porque o prompt precisa dos dois:
 * o ref para as ferramentas usarem, o nome para o modelo conseguir conversar
 * sobre o projeto com o usuario sem falar em codigo de identificacao.
 */
export async function getRepoProject(
  platformId: PlatformId,
  repoId: RepoId,
): Promise<PlatformProject | null> {
  const ref = await getRepoProjectRef(platformId, repoId);
  if (!ref) return null;
  const conexao = (await getPlatformConnections()).find((item) => item.id === platformId);
  if (!conexao?.hasToken) return null;
  return conexao.projects?.find((projeto) => projeto.ref === ref) ?? { ref, name: ref };
}

/**
 * Todos os vinculos DESTE repositorio, prontos para o system prompt.
 *
 * Plataforma sem token, ou com token mas sem projeto escolhido, simplesmente
 * nao entra. E' de proposito: metade da informacao ("existe um Supabase, mas
 * nao sei qual projeto") e' pior do que nenhuma — convida o modelo a procurar.
 */
export async function platformLinksForRepo(repoId: RepoId): Promise<RepoPlatformLink[]> {
  assertRepoId(repoId);
  const resolvidos = await Promise.all(
    PLATFORMS.map(async (plataforma) => {
      const project = await getRepoProject(plataforma.id, repoId);
      return project ? { platformId: plataforma.id, project } : null;
    }),
  );
  return resolvidos.filter((item): item is RepoPlatformLink => item !== null);
}
