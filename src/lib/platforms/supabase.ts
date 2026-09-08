import { platformById } from './types';

/**
 * Verificacao do token do Supabase contra a Management API.
 *
 * Guardar credencial sem testar e' o mesmo defeito que ja mordeu na chave do
 * provedor de IA: a pessoa so descobre que errou muito depois, num erro que
 * fala de outra coisa. `/v1/projects` e' a chamada mais barata que prova as
 * tres coisas de uma vez — o token existe, e valido e enxerga alguma coisa.
 */

interface ProjetoDaApi {
  id?: string;
  name?: string;
  region?: string;
}

export interface PlatformCheck {
  ok: boolean;
  message: string;
  /** Nomes dos projetos que o token enxerga. Vazio nao e' erro. */
  projects: string[];
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
  const projects = (Array.isArray(payload) ? payload : [])
    .map((projeto) => projeto.name)
    .filter((nome): nome is string => typeof nome === 'string' && nome.length > 0)
    .sort();

  return {
    ok: true,
    message:
      projects.length > 0
        ? `Token valido — ${projects.length} projeto(s): ${projects.slice(0, 5).join(', ')}${projects.length > 5 ? '…' : ''}`
        : 'Token valido, mas a conta nao tem projeto nenhum ainda.',
    projects,
  };
}
