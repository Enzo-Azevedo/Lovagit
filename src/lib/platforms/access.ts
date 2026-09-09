import type { McpServerConfig } from '../mcp/types';
import type { RepoId } from '../types';
import { platformForMcpUrl, type PlatformId, type RepoPlatformLink } from './types';

/**
 * Como um repositorio alcanca uma plataforma — ou por que nao alcanca.
 *
 * A regra e' uma so: "existe vinculo de plataforma E nenhum servidor MCP casa
 * com o host dela". Ela estava escrita duas vezes, no bloco de plataformas das
 * opcoes e no `descreverAcesso` do prompt, e ia virar tres com o selo do painel
 * lateral. Regra copiada diverge na primeira mudanca — e o jeito de divergir
 * aqui e' o pior possivel: uma tela dizendo que ha acesso enquanto o prompt diz
 * ao modelo que nao ha.
 */

/**
 * O servidor MCP desta plataforma, numa lista JA filtrada pelo repositorio.
 *
 * Casa por host exato (`platformForMcpUrl`), nunca por sufixo: `mcp.supabase.com`
 * e' o servico, `mcp.supabase.com.evil.test` e' outra pessoa.
 */
export function serverForPlatform(
  platformId: PlatformId,
  servers: McpServerConfig[],
): McpServerConfig | undefined {
  return servers.find((server) => platformForMcpUrl(server.url)?.id === platformId);
}

/**
 * Idem, mas partindo da lista COMPLETA de servidores.
 *
 * Servidor cadastrado e nao habilitado para este repositorio nao conta: ele
 * existe no cadastro e nao existe nesta conversa, e e' a conversa que importa.
 */
export function serverForPlatformInRepo(
  platformId: PlatformId,
  repoId: RepoId,
  servers: McpServerConfig[],
): McpServerConfig | undefined {
  return serverForPlatform(
    platformId,
    servers.filter((server) => server.enabledRepoIds.includes(repoId)),
  );
}

/**
 * Os vinculos que o modelo enxerga mas nao consegue tocar.
 *
 * E' o estado que enganava: o projeto aparece configurado, o prompt conta que
 * ele existe, e nao ha ferramenta nenhuma para chegar nele. Quem pergunta sobre
 * o banco recebe um "nenhum resultado" que veio de busca em codigo.
 */
export function linksWithoutTool(
  links: RepoPlatformLink[],
  serversDoRepo: McpServerConfig[],
): RepoPlatformLink[] {
  return links.filter((link) => !serverForPlatform(link.platformId, serversDoRepo));
}
