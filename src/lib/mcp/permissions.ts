/**
 * Permissao de host para falar com um servidor MCP.
 *
 * Sem isto nada funcionava, e o sintoma enganava: o `fetch` para o servidor
 * saia da pagina da extensao como requisicao cross-origin comum, e servidor MCP
 * nenhum devolve `Access-Control-Allow-Origin` para origem `chrome-extension://`.
 * O navegador barrava antes de a requisicao chegar, e o erro que sobrava era
 * "nao foi possivel alcancar o servidor" — que parece rede fora do ar.
 *
 * O manifest declara `optional_host_permissions` justamente para isto, mas
 * permissao opcional nao vale nada enquanto ninguem a pede. E quem pede tem que
 * pedir de dentro do gesto do usuario: o Chrome recusa `permissions.request`
 * fora de um clique, e QUALQUER `await` antes dele ja encerra o gesto.
 */

/** Padrao de origem que a permissao usa, ou `null` se a URL nao for valida. */
export function originPatternFor(url: string): string | null {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return null;
  }
}

/**
 * Pede a permissao. Chame como PRIMEIRA operacao assincrona do clique.
 *
 * Nao consulta `permissions.contains` antes de proposito: a consulta e' um
 * `await`, gastaria o gesto, e o proprio `request` ja devolve `true` na hora
 * quando a permissao existe — sem mostrar dialogo nenhum ao usuario.
 */
export async function requestHostPermission(url: string): Promise<boolean> {
  const origins = originPatternFor(url);
  if (!origins) return false;
  return chrome.permissions.request({ origins: [origins] });
}

/** Consulta, sem pedir. Serve para explicar a falha, nao para abrir dialogo. */
export async function hasHostPermission(url: string): Promise<boolean> {
  const origins = originPatternFor(url);
  if (!origins) return false;
  return chrome.permissions.contains({ origins: [origins] });
}
