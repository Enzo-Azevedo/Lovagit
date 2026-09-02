import { describe, expect, it, vi } from 'vitest';
import {
  createOpenAICompatibleProvider,
  kindForStreamErrorCode,
  providerKindForStatus,
} from '../ai/openai-compatible';
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
  it('vira ProviderError de rede quando cai sem nada ter chegado', async () => {
    // Sem texto util, a queda e erro mesmo — nao ha resposta parcial a
    // preservar. (O caso com texto parcial esta em "preservacao do texto
    // parcial": la a resposta e devolvida em vez de descartada.)
    const provider = providerWith((async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch);

    const erro = await provider.complete(pedido).catch((caught: unknown) => caught);

    expect(erro).toBeInstanceOf(ProviderError);
    expect((erro as ProviderError).kind).toBe('network');
    expect((erro as ProviderError).message).toContain('caiu durante a resposta');
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

describe('erro em banda (HTTP 200 com erro dentro do stream)', () => {
  function streamOf(...frames: string[]) {
    return (async () => {
      let etapa = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (etapa < frames.length) {
            controller.enqueue(new TextEncoder().encode(frames[etapa]));
            etapa += 1;
            return;
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('nao deixa erro do agregador virar resposta vazia silenciosa', async () => {
    // Agregadores respondem 200 e reportam a falha dentro do stream. Ignorar
    // esse frame fazia o turno terminar vazio, sem erro nenhum na interface.
    const provider = providerWith(
      streamOf(
        'data: {"choices":[{"delta":{"content":"comecou"}}]}\n\n',
        'data: {"error":{"message":"Provider returned error","code":502},"choices":[]}\n\n',
      ),
    );

    const erro = (await provider.complete(pedido).catch((c: unknown) => c)) as ProviderError;

    expect(erro).toBeInstanceOf(ProviderError);
    expect(erro.message).toContain('Provider returned error');
    expect(erro.message).toContain('502');
    // 502 e passageiro: nao deve abrir issue.
    expect(erro.kind).toBe('rate-limit');
  });

  it('classifica erro de credencial em banda como auth', async () => {
    const provider = providerWith(
      streamOf('data: {"error":{"message":"No auth credentials","code":401},"choices":[]}\n\n'),
    );
    const erro = (await provider.complete(pedido).catch((c: unknown) => c)) as ProviderError;
    expect(erro.kind).toBe('auth');
  });

  it('ignora os comentarios de keep-alive do OpenRouter', async () => {
    // ": OPENROUTER PROCESSING" nao e JSON; tratar como dado quebra o parse.
    const provider = providerWith(
      streamOf(
        ': OPENROUTER PROCESSING\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ),
    );
    const resposta = await provider.complete(pedido);
    expect(resposta.text).toBe('ok');
  });
});

describe('preservacao do texto parcial', () => {
  it('devolve o que chegou quando a queda nao tem tool call pendente', async () => {
    const provider = providerWith((async () => {
      let etapa = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (etapa === 0) {
            etapa += 1;
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"resposta parcial"}}]}\n\n'),
            );
            return;
          }
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch);

    const resposta = await provider.complete(pedido);

    expect(resposta.text).toBe('resposta parcial');
    expect(resposta.stopReason).toBe('interrupted');
    expect(resposta.toolCalls).toEqual([]);
  });

  it('descarta tool call truncado em vez de devolver argumentos pela metade', async () => {
    // Um write_file com JSON cortado escreveria um arquivo truncado no repo.
    const provider = providerWith((async () => {
      let etapa = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (etapa === 0) {
            etapa += 1;
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\\"path\\":\\"a.ts\\",\\"content\\":\\"metade"}}]}}]}\n\n',
              ),
            );
            return;
          }
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch);

    const erro = (await provider.complete(pedido).catch((c: unknown) => c)) as ProviderError;

    expect(erro).toBeInstanceOf(ProviderError);
    expect(erro.kind).toBe('network');
  });
});

describe('providerKindForStatus', () => {
  it('separa o que e da conta do que e defeito nosso', () => {
    const casos: [number, string][] = [
      [401, 'auth'],
      [403, 'auth'],
      // Sem credito e modelo/endpoint inexistente: quem resolve e o dono da conta.
      [402, 'unavailable'],
      [404, 'unavailable'],
      [408, 'rate-limit'],
      [429, 'rate-limit'],
      [502, 'rate-limit'],
      // 400 e 422 sao payload que NOS montamos — esses sim sao defeito.
      [400, 'http'],
      [422, 'http'],
    ];
    for (const [status, esperado] of casos) {
      expect(providerKindForStatus(status), `status ${status}`).toBe(esperado);
    }
  });

  it('erro em banda usa o mesmo mapeamento do status HTTP', () => {
    expect(kindForStreamErrorCode(404)).toBe('unavailable');
    expect(kindForStreamErrorCode('404')).toBe('unavailable');
    expect(kindForStreamErrorCode(undefined)).toBe('http');
  });
});
