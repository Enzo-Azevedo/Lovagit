import { platformById, type PlatformProject } from './types';

/**
 * Verificacao do token do Supabase contra a Management API.
 *
 * Guardar credencial sem testar e' o mesmo defeito que ja mordeu na chave do
 * provedor de IA: a pessoa so descobre que errou muito depois, num erro que
 * fala de outra coisa. `/v1/projects` e' a chamada mais barata que prova as
 * tres coisas de uma vez — o token existe, e valido e enxerga alguma coisa.
 */

interface ProjetoDaApi {
  /** No Supabase, o `id` da Management API E' o project ref usado nas
   *  ferramentas. Guardar o nome sozinho nao serviria para chamar nada. */
  id?: string;
  name?: string;
  region?: string;
}

export interface PlatformCheck {
  ok: boolean;
  message: string;
  /** Projetos que o token enxerga. Vazio nao e' erro. */
  projects: PlatformProject[];
}

export async function checkSupabaseToken(token: string): Promise<PlatformCheck> {
  const plataforma = platformById('supabase');
  const url = `${plataforma?.apiOrigin ?? 'https://api.supabase.com'}/v1/projects`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/json' },
    });
  } catch (error) {
    // Quase sempre e' permissao de host faltando: o navegador barra antes de a
    // requisicao sair e devolve um "Failed to fetch" com cara de rede caida.
    return {
      ok: false,
      message:
        `Nao foi possivel alcancar ${url}. Se o navegador nao pediu permissao para ` +
        `${plataforma?.apiOrigin}, conceda e tente de novo. (${
          error instanceof Error ? error.message : String(error)
        })`,
      projects: [],
    };
  }

  if (response.status === 401) {
    return { ok: false, message: 'Token recusado pelo Supabase (401). Confira se ele nao foi revogado.', projects: [] };
  }
  if (!response.ok) {
    const detalhe = await response.text().catch(() => '');
    return {
      ok: false,
      message: `Supabase respondeu ${response.status}: ${detalhe.slice(0, 200) || response.statusText}`,
      projects: [],
    };
  }

  const payload = (await response.json().catch(() => [])) as ProjetoDaApi[];
  const projects: PlatformProject[] = (Array.isArray(payload) ? payload : [])
    // Sem `id` nao da para vincular nada: o ref e' o que as ferramentas usam.
    .filter((projeto) => typeof projeto.id === 'string' && projeto.id.length > 0)
    .map((projeto) => ({
      ref: projeto.id as string,
      name: projeto.name ?? (projeto.id as string),
      region: projeto.region,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const nomes = projects.map((projeto) => projeto.name);
  return {
    ok: true,
    message:
      projects.length > 0
        ? `Token valido — ${projects.length} projeto(s): ${nomes.slice(0, 5).join(', ')}${nomes.length > 5 ? '…' : ''}`
        : 'Token valido, mas a conta nao tem projeto nenhum ainda.',
    projects,
  };
}
