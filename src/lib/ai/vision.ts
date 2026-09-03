import type { ProviderConfig } from '../types';

/**
 * O modelo enxerga imagem?
 *
 * `unknown` nao e' meio-termo preguicoso: e' a resposta correta para um
 * endpoint compativel com OpenAI que ninguem catalogou. Bloquear o envio nesse
 * caso quebraria gateway proprio e modelo recem-lancado que funcionam bem.
 */
export type VisionSupport = 'yes' | 'no' | 'unknown';

/** Formatos que os provedores aceitam. GIF animado entra como imagem estatica. */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Teto por imagem. Acima disso o custo em tokens e o storage saem de controle. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Teto por mensagem. */
export const MAX_IMAGES_PER_MESSAGE = 4;

interface OpenRouterModel {
  id: string;
  architecture?: { input_modalities?: string[] | null } | null;
}

/** Catalogo do OpenRouter, buscado uma vez por sessao. */
let catalogo: Promise<Map<string, string[]>> | null = null;

async function openRouterModalities(): Promise<Map<string, string[]>> {
  catalogo ??= (async () => {
    const porModelo = new Map<string, string[]>();
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models');
      if (!response.ok) return porModelo;
      const payload = (await response.json()) as { data?: OpenRouterModel[] };
      for (const modelo of payload.data ?? []) {
        porModelo.set(modelo.id, modelo.architecture?.input_modalities ?? []);
      }
    } catch {
      // Sem catalogo, todo modelo vira `unknown` — que e' o certo: nao da para
      // afirmar que nao enxerga so porque a lista nao carregou.
    }
    return porModelo;
  })();
  return catalogo;
}

/** So para teste: descarta o catalogo em memoria. */
export function resetVisionCache(): void {
  catalogo = null;
}

export function isOpenRouter(baseUrl: string): boolean {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Descobre se o provedor ativo enxerga imagem.
 *
 * - Anthropic: toda a familia Claude atual aceita imagem.
 * - OpenRouter: o catalogo publica `input_modalities` por modelo — e' a unica
 *   fonte que permite dizer "nao" com seguranca.
 * - Qualquer outro endpoint: `unknown`.
 */
export async function detectVisionSupport(provider: ProviderConfig): Promise<VisionSupport> {
  if (provider.kind === 'anthropic') return 'yes';

  const baseUrl = 'baseUrl' in provider ? provider.baseUrl : '';
  if (!isOpenRouter(baseUrl)) return 'unknown';

  const modalidades = (await openRouterModalities()).get(provider.model);
  if (modalidades === undefined || modalidades.length === 0) return 'unknown';
  return modalidades.includes('image') ? 'yes' : 'no';
}

export function describeVision(support: VisionSupport, model: string): string | null {
  if (support === 'yes') return null;
  if (support === 'no') {
    return `${model} nao le imagens. Troque de modelo ou remova o anexo.`;
  }
  return `Nao da para confirmar se ${model} le imagens; se ele ignorar o anexo, a resposta vem como se ele nao existisse.`;
}

/** Valida um arquivo antes de virar anexo. Devolve o motivo da recusa, ou null. */
export function rejectionReason(file: { type: string; size: number; name: string }): string | null {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
    return `${file.name}: formato ${file.type || 'desconhecido'} nao suportado (use PNG, JPEG, WebP ou GIF).`;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `${file.name}: ${(file.size / (1024 * 1024)).toFixed(1)} MB passa do limite de 5 MB por imagem.`;
  }
  return null;
}
