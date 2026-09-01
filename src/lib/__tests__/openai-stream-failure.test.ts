import { describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleProvider } from '../ai/openai-compatible';
import { ProviderError } from '../ai/types';

/**
 * Regressao da issue #5: a conexao caia no meio do streaming, o Chrome
 * rejeitava a leitura com `TypeError: network error`, e isso subia cru — sem
 * dizer nada ao usuario e classificado como defeito da extensao.
 */

function providerWith(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl);
  return createOpenAICompatibleProvider({
    id: 'p1',
    label: 'Provedor',
    model: 'modelo-x',
    maxTokens: 100,
    baseUrl: 'https://exemplo.com/v1',
    getAuthToken: async () => 'chave',
  });
}

const pedido = { system: 'sistema', turns: [{ role: 'user' as const, text: 'oi' }], tools: [] };

describe('falha de rede no streaming', () => {
  it('vira ProviderError de rede quando o stream e interrompido', async () => {
    // O chunk sai numa chamada de `pull` e o erro na seguinte: enfileirar e
    // errar na mesma tick faz o stream descartar o que estava na fila, e o
    // caso que interessa aqui e justamente o texto que chegou antes da queda.
    const provider = providerWith((async () => {
      let etapa = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (etapa === 0) {
            etapa += 1;
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"parcial"}}]}\n\n'),
            );
            return;
          }
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch);

    const erro = await provider.complete(pedido).catch((caught: unknown) => caught);

    expect(erro).toBeInstanceOf(ProviderError);
    expect((erro as ProviderError).kind).toBe('network');
    // A mensagem precisa dizer o que aconteceu e quanto chegou antes da queda.
    expect((erro as ProviderError).message).toContain('caiu durante a resposta');
    expect((erro as ProviderError).message).toContain('7 caractere(s)');
  });

  it('vira ProviderError de rede quando a requisicao nem sai', async () => {
    const provider = providerWith((async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);

    const erro = (await provider.complete(pedido).catch((caught: unknown) => caught)) as ProviderError;

    expect(erro).toBeInstanceOf(ProviderError);
    expect(erro.kind).toBe('network');
    // Numa extensao a causa mais comum e permissao de host — a mensagem diz isso.
    expect(erro.message).toContain('permissao para essa origem');
  });

  it('nao mascara um cancelamento do usuario como falha de rede', async () => {
    const controller = new AbortController();
    const provider = providerWith((async () => {
      const body = new ReadableStream({
        start(streamController) {
          controller.abort();
          streamController.error(new DOMException('Cancelado', 'AbortError'));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch);

    const erro = await provider
      .complete({ ...pedido, signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(erro).not.toBeInstanceOf(ProviderError);
    expect((erro as Error).name).toBe('AbortError');
  });
});
