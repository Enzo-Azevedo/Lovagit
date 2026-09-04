import { describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleProvider } from '../ai/openai-compatible';
import { ProviderError } from '../ai/types';

/**
 * Credencial em branco nao pode virar requisicao.
 *
 * O sintoma que motivou isto: o OpenRouter respondia
 * `{"error":{"message":"Missing Authentication header","code":401}}` — e a frase
 * mandava procurar um header que a extensao TINHA mandado. Verificando contra a
 * API real, a mensagem dele separa tres casos:
 *
 * - header ausente de verdade  -> "No cookie auth credentials found"
 * - `Bearer ` com token vazio  -> "Missing Authentication header"
 * - chave errada mas presente  -> "User not found."
 *
 * Ou seja: quem via aquela frase tinha uma chave vazia sendo enviada, nao uma
 * chave errada. O `!apiKey` de antes deixava passar chave so de espacos, que e'
 * truthy e chega ao provedor exatamente como chave vazia.
 */

const naoDeviaChamar = vi.fn(async () => new Response('{}'));

function provider(patch: { token?: string | null; model?: string } = {}) {
  vi.stubGlobal('fetch', naoDeviaChamar);
  return createOpenAICompatibleProvider({
    id: 'p1',
    label: 'OpenRouter',
    model: patch.model ?? 'vendor/modelo',
    maxTokens: 100,
    baseUrl: 'https://openrouter.ai/api/v1',
    getAuthToken: async () => patch.token ?? '',
  });
}

const pedido = { system: 's', turns: [{ role: 'user' as const, text: 'oi' }], tools: [] };

describe('credencial em branco', () => {
  it('chave vazia para antes da rede, dizendo onde resolver', async () => {
    naoDeviaChamar.mockClear();
    const erro = await provider({ token: '' })
      .complete(pedido)
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ProviderError);
    expect((erro as ProviderError).kind).toBe('auth');
    expect((erro as ProviderError).message).toContain('Configuracoes');
    expect(naoDeviaChamar, 'chave vazia nao vira requisicao').not.toHaveBeenCalled();
  });

  it('chave so de espacos conta como vazia — era exatamente o defeito', async () => {
    naoDeviaChamar.mockClear();
    await expect(provider({ token: '   ' }).complete(pedido)).rejects.toThrow(/chave de API/i);
    expect(naoDeviaChamar).not.toHaveBeenCalled();
  });

  it('token nulo do login OAuth tambem para aqui', async () => {
    // O caminho OAuth entrega o token por uma funcao; se ela devolver nada, o
    // `Bearer null` sairia como chave vazia do mesmo jeito.
    naoDeviaChamar.mockClear();
    await expect(provider({ token: null }).complete(pedido)).rejects.toThrow(ProviderError);
    expect(naoDeviaChamar).not.toHaveBeenCalled();
  });

  it('modelo em branco tambem para antes da rede', async () => {
    // O campo "Modelo" vazio manda `model: ""` e o provedor recusa com um texto
    // que nao ajuda ninguem. Dizer aqui custa uma linha.
    naoDeviaChamar.mockClear();
    const erro = await provider({ token: 'sk-or-v1-valida', model: '  ' })
      .complete(pedido)
      .catch((e: unknown) => e);

    expect((erro as ProviderError).message).toContain('modelo');
    expect(naoDeviaChamar).not.toHaveBeenCalled();
  });
});

describe('401 do provedor', () => {
  it('acrescenta onde conferir a chave', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"User not found.","code":401}}', { status: 401 })),
    );
    const p = createOpenAICompatibleProvider({
      id: 'p1',
      label: 'OpenRouter',
      model: 'vendor/modelo',
      maxTokens: 100,
      baseUrl: 'https://openrouter.ai/api/v1',
      getAuthToken: async () => 'sk-or-v1-errada',
    });

    const erro = await p.complete(pedido).catch((e: unknown) => e);

    expect((erro as ProviderError).kind).toBe('auth');
    // O texto do provedor continua ali: e' o que diz se a chave e' invalida ou
    // se a conta acabou. A dica so completa.
    expect((erro as ProviderError).message).toContain('User not found');
    expect((erro as ProviderError).message).toContain('Configuracoes');
  });
});
