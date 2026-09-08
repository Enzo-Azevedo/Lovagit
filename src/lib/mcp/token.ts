import { deleteSecret, getSecret, SecretNames, setSecret } from '../vault';

/**
 * Token de acesso colado a mao, como o `sbp_...` do Supabase.
 *
 * Existe porque OAuth nao cobre todo mundo. Servidor sem registro dinamico
 * exige app previamente cadastrado no painel do provedor — o caminho das
 * "parcerias" — e a saida documentada desses servicos e' justamente um token
 * pessoal no cabecalho. O do Supabase e' assim: OAuth para uso interativo, PAT
 * para o resto.
 *
 * Fica no cofre cifrado, junto do PAT do GitHub e das chaves de API. Nunca na
 * configuracao do servidor, que e' `chrome.storage.local` em texto puro.
 */

export async function setServerToken(serverId: string, token: string): Promise<boolean> {
  const limpo = token.trim();
  if (!limpo) {
    await clearServerToken(serverId);
    return false;
  }
  await setSecret(SecretNames.mcpToken(serverId), limpo);
  return true;
}

export async function getServerToken(serverId: string): Promise<string | null> {
  const guardado = await getSecret(SecretNames.mcpToken(serverId));
  // Token so de espacos e' o mesmo que token nenhum: mandar `Bearer   ` faz o
  // servidor responder um 401 que fala de credencial ausente.
  const limpo = guardado?.trim();
  return limpo ? limpo : null;
}

export async function clearServerToken(serverId: string): Promise<void> {
  await deleteSecret(SecretNames.mcpToken(serverId));
}
