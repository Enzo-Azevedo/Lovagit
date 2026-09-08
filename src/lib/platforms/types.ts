/**
 * Plataformas de servico com token proprio.
 *
 * Sao "fixas" no sentido de conhecidas de antemao: ao contrario de um servidor
 * MCP, que e' uma URL qualquer que o usuario cadastra, aqui a extensao ja sabe
 * onde fica a API, como o token se chama e onde ele e' emitido. O que falta e'
 * so o token.
 *
 * O modelo e' o mesmo do PAT do GitHub, que a extensao ja usa desde o inicio:
 * uma credencial pessoal, emitida no painel do proprio servico, enviada em
 * `Authorization: Bearer`.
 */

export type PlatformId = 'supabase';

export interface PlatformDefinition {
  id: PlatformId;
  label: string;
  /** Prefixo do token, para avisar cedo quando colam a credencial errada. */
  tokenPrefix: string;
  tokenLabel: string;
  /** Onde o usuario emite o token. */
  createUrl: string;
  /** Origem da API — precisa de permissao de host antes da primeira chamada. */
  apiOrigin: string;
  /**
   * Servidores MCP que aceitam este mesmo token. Salvar a credencial uma vez em
   * "Conexoes" evita ter que repetir a mesma coisa no servidor MCP do servico.
   */
  mcpHosts: string[];
  /** O que o token dá acesso — texto de tela, nao decoracao: token de
   *  plataforma costuma ser mais poderoso do que parece. */
  scopeWarning: string;
}

export const PLATFORMS: PlatformDefinition[] = [
  {
    id: 'supabase',
    label: 'Supabase',
    tokenPrefix: 'sbp_',
    tokenLabel: 'Personal access token',
    createUrl: 'https://supabase.com/dashboard/account/tokens',
    apiOrigin: 'https://api.supabase.com',
    mcpHosts: ['mcp.supabase.com'],
    scopeWarning:
      'Um token sem escopo tem os mesmos privilegios da conta que o criou — todos os projetos, ' +
      'nao so um. Prefira um token com escopo quando o Supabase oferecer.',
  },
];

export function platformById(id: PlatformId): PlatformDefinition | undefined {
  return PLATFORMS.find((platform) => platform.id === id);
}

/** Plataforma cujo token serve para este servidor MCP, se houver. */
export function platformForMcpUrl(url: string): PlatformDefinition | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return PLATFORMS.find((platform) => platform.mcpHosts.includes(host));
}

/**
 * Um projeto dentro da conta da plataforma.
 *
 * O `ref` e' o identificador que as ferramentas usam (no Supabase, o
 * `project_id`); o nome e' so para a tela — dois projetos podem ter nomes
 * parecidos, e escolher pelo nome errado e' escolher o banco errado.
 */
export interface PlatformProject {
  ref: string;
  name: string;
  region?: string;
}

/** Estado de uma conexao, guardado em claro — o token fica no cofre. */
export interface PlatformConnection {
  id: PlatformId;
  hasToken: boolean;
  /** Resumo do ultimo teste bem-sucedido, ex.: "3 projeto(s)". */
  lastCheck?: string;
  lastCheckedAt?: number;
  lastError?: string;
  /** Projetos vistos no ultimo teste. E' a lista que a tela oferece para
   *  escolher, sem precisar chamar a API a cada render. */
  projects?: PlatformProject[];
}

/**
 * Qual projeto cada repositorio usa, por plataforma.
 *
 * Nao ha padrao e nao ha "todos": a escolha e' obrigatoria e explicita. Duas
 * razoes, e as duas doem:
 *
 * 1. **Isolamento.** A conta inteira do Supabase esta ao alcance do token. Sem
 *    o vinculo, o chat do repositorio X poderia mexer no banco do projeto Y —
 *    exatamente o cruzamento que esta extensao existe para impedir.
 * 2. **Custo.** Sem saber qual e' o projeto, o modelo lista todos e vai
 *    tentando ate acertar. Cada tentativa e' um turno pago para descobrir algo
 *    que o usuario ja sabia.
 */
export type PlatformLinks = Record<string, Record<string, string>>;
