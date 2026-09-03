import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeVision,
  detectVisionSupport,
  isOpenRouter,
  MAX_IMAGE_BYTES,
  rejectionReason,
  resetVisionCache,
} from '../ai/vision';
import type { ProviderConfig } from '../types';

afterEach(() => {
  resetVisionCache();
  vi.unstubAllGlobals();
});

function openRouterCom(modelos: { id: string; modalidades: string[] }[]) {
  vi.stubGlobal('fetch', (async () => ({
    ok: true,
    json: async () => ({
      data: modelos.map((m) => ({ id: m.id, architecture: { input_modalities: m.modalidades } })),
    }),
  })) as unknown as typeof fetch);
}

const openRouter = (model: string): ProviderConfig => ({
  id: 'p1',
  kind: 'openai-compatible',
  label: 'OpenRouter',
  model,
  maxTokens: 4096,
  baseUrl: 'https://openrouter.ai/api/v1',
});

describe('isOpenRouter', () => {
  it('nao confunde host parecido com o de verdade', () => {
    expect(isOpenRouter('https://openrouter.ai/api/v1')).toBe(true);
    expect(isOpenRouter('https://naoopenrouter.ai/v1')).toBe(false);
    expect(isOpenRouter('https://openrouter.ai.exemplo.com/v1')).toBe(false);
    expect(isOpenRouter('nao e url')).toBe(false);
  });
});

describe('detectVisionSupport', () => {
  it('Claude enxerga imagem — a familia inteira aceita', async () => {
    const anthropic: ProviderConfig = {
      id: 'p',
      kind: 'anthropic',
      label: 'Claude',
      model: 'claude-opus-5',
      maxTokens: 4096,
      baseUrl: 'https://api.anthropic.com',
    };
    expect(await detectVisionSupport(anthropic)).toBe('yes');
  });

  it('le o catalogo do OpenRouter para dizer sim ou nao', async () => {
    openRouterCom([
      { id: 'vendor/com-visao', modalidades: ['text', 'image'] },
      { id: 'vendor/so-texto', modalidades: ['text'] },
    ]);

    expect(await detectVisionSupport(openRouter('vendor/com-visao'))).toBe('yes');
    expect(await detectVisionSupport(openRouter('vendor/so-texto'))).toBe('no');
  });

  it('modelo fora do catalogo fica desconhecido, nao "nao"', async () => {
    // Dizer "nao" aqui bloquearia um modelo recem-lancado que enxerga bem.
    openRouterCom([{ id: 'vendor/conhecido', modalidades: ['text'] }]);
    expect(await detectVisionSupport(openRouter('vendor/novissimo'))).toBe('unknown');
  });

  it('catalogo fora do ar nao vira "nao"', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    expect(await detectVisionSupport(openRouter('vendor/qualquer'))).toBe('unknown');
  });

  it('endpoint compativel desconhecido fica desconhecido', async () => {
    const proprio: ProviderConfig = {
      id: 'p',
      kind: 'openai-compatible',
      label: 'Meu gateway',
      model: 'interno',
      maxTokens: 4096,
      baseUrl: 'https://gateway.interno/v1',
    };
    expect(await detectVisionSupport(proprio)).toBe('unknown');
  });
});

describe('describeVision', () => {
  it('cala a boca quando o modelo enxerga', () => {
    expect(describeVision('yes', 'claude-opus-5')).toBeNull();
  });

  it('e categorico no "nao" e cauteloso no "nao sei"', () => {
    expect(describeVision('no', 'so-texto')).toContain('nao le imagens');
    expect(describeVision('unknown', 'misterioso')).toContain('Nao da para confirmar');
  });
});

describe('rejectionReason', () => {
  it('aceita os formatos que os provedores entendem', () => {
    expect(rejectionReason({ type: 'image/png', size: 1000, name: 'a.png' })).toBeNull();
    expect(rejectionReason({ type: 'image/webp', size: 1000, name: 'a.webp' })).toBeNull();
  });

  it('recusa formato que nenhum provedor aceita', () => {
    const motivo = rejectionReason({ type: 'application/pdf', size: 100, name: 'doc.pdf' });
    expect(motivo).toContain('nao suportado');
  });

  it('recusa imagem grande demais', () => {
    const motivo = rejectionReason({
      type: 'image/png',
      size: MAX_IMAGE_BYTES + 1,
      name: 'enorme.png',
    });
    expect(motivo).toContain('limite de 5 MB');
  });
});
