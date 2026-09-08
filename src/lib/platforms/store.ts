import { deleteSecret, getSecret, SecretNames, setSecret } from '../vault';
import {
  PLATFORMS,
  platformForMcpUrl,
  type PlatformConnection,
  type PlatformId,
} from './types';

/**
 * Conexoes de plataforma: token no cofre, estado em claro.
 *
 * O token nunca encosta em `chrome.storage.local`, que e' texto puro. O que
 * fica la e' so o suficiente para desenhar a tela — se ha token, quando foi
 * testado pela ultima vez e como foi.
 */

const KEY = 'platforms:connections';

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
