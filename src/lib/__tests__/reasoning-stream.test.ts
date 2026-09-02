import { describe, expect, it, vi } from 'vitest';
import {
  acceptsReasoningParam,
  applyChunk,
  createOpenAICompatibleProvider,
  reasoningFromDelta,
} from '../ai/openai-compatible';
import { ProviderError } from '../ai/types';

/**
 * O `Upstream idle timeout exceeded` do OpenRouter estoura quando o modelo passa
 * muito tempo pensando sem emitir nada: o intermediario desiste de esperar o
 * provedor de origem. Pedir o raciocinio mantem trafego no stream durante essa
 * fase — e, mesmo quando nao evita a queda, e o que a interface tem para mostrar
 * que o modelo nao travou.
 */

function emptyAcc() {
  return {
    text: '',
    reasoning: '',
    toolCalls: new Map<number, { id: string; name: string; args: string }>(),
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function sse(...frames: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const pedido = { system: 'sistema', turns: [{ role: 'user' as const, text: 'oi' }], tools: [] };

describe('leitura do raciocinio', () => {
  it('le o campo direto de cada provedor', () => {
    for (const campo of ['reasoning', 'reasoning_content', 'reasoning_text']) {
      expect(reasoningFromDelta({ [campo]: 'pensando' })).toBe('pensando');
    }
  });

  it('le o array reasoning_details, que era descartado', () => {
    const texto = reasoningFromDelta({
      reasoning_details: [
        { type: 'reasoning.text', text: 'primeiro ' },
        { type: 'reasoning.summary', summary: 'segundo' },
      ],
    });
    expect(texto).toBe('primeiro segundo');
  });

  it('ignora bloco cifrado, que nao tem texto legivel', () => {
    expect(reasoningFromDelta({ reasoning_details: [{ type: 'reasoning.encrypted' }] })).toBe('');
    expect(reasoningFromDelta(undefined)).toBe('');
    expect(reasoningFromDelta({ content: 'resposta' })).toBe('');
  });

  it('prefere o campo direto quando o provedor manda os dois', () => {
    const texto = reasoningFromDelta({
      reasoning: 'direto',
      reasoning_details: [{ text: 'array' }],
    });
    expect(texto).toBe('direto');
  });

  it('acumula e repassa o raciocinio para a UI, sem misturar com a resposta', () => {
    const acc = emptyAcc();
    const raciocinio: string[] = [];
    const resposta: string[] = [];

    applyChunk(
      acc,
      { choices: [{ delta: { reasoning_details: [{ text: 'pensei ' }] } }] },
      (t) => resposta.push(t),
      (t) => raciocinio.push(t),
    );
    applyChunk(
      acc,
      { choices: [{ delta: { reasoning: 'mais' } }] },
      (t) => resposta.push(t),
      (t) => raciocinio.push(t),
    );
    applyChunk(
      acc,
      { choices: [{ delta: { content: 'resposta' } }] },
      (t) => resposta.push(t),
      (t) => raciocinio.push(t),
    );

    expect(acc.reasoning).toBe('pensei mais');
    expect(acc.text).toBe('resposta');
    expect(raciocinio).toEqual(['pensei ', 'mais']);
    expect(resposta).toEqual(['resposta']);
  });
});

describe('parametro de raciocinio', () => {
  it('so reconhece o OpenRouter — em outro endpoint o parametro daria 400', () => {
    expect(acceptsReasoningParam('https://openrouter.ai/api/v1/chat/completions')).toBe(true);
    expect(acceptsReasoningParam('https://api.openrouter.ai/v1/chat/completions')).toBe(true);
    expect(acceptsReasoningParam('https://api.openai.com/v1/chat/completions')).toBe(false);
    expect(acceptsReasoningParam('https://api.groq.com/openai/v1/chat/completions')).toBe(false);
    // Host que apenas termina parecido nao pode passar por OpenRouter.
    expect(acceptsReasoningParam('https://naoopenrouter.ai/v1')).toBe(false);
    expect(acceptsReasoningParam('https://openrouter.ai.exemplo.com/v1')).toBe(false);
    expect(acceptsReasoningParam('nao e uma url')).toBe(false);
  });

  function providerEm(baseUrl: string, fetchImpl: typeof fetch) {
    vi.stubGlobal('fetch', fetchImpl);
    return createOpenAICompatibleProvider({
      id: 'p1',
      label: 'Provedor',
      model: 'modelo-x',
      maxTokens: 100,
      baseUrl,
      getAuthToken: async () => 'chave',
    });
  }

  it('pede o raciocinio no OpenRouter e nao pede nos demais', async () => {
    const corpos: Record<string, unknown>[] = [];
    const espiao = (async (_url: string, init: RequestInit) => {
      corpos.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n');
    }) as unknown as typeof fetch;

    await providerEm('https://openrouter.ai/api/v1', espiao).complete(pedido);
    await providerEm('https://api.openai.com/v1', espiao).complete(pedido);

    expect(corpos[0].reasoning).toEqual({ enabled: true });
    expect(corpos[1]).not.toHaveProperty('reasoning');
  });

  it('refaz a chamada sem o parametro quando o modelo o recusa', async () => {
    // Ha modelos no OpenRouter que recusam o campo. Um extra nosso nunca pode
    // ser o motivo de a conversa nao sair.
    const corpos: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const corpo = JSON.parse(String(init.body)) as Record<string, unknown>;
      corpos.push(corpo);
      if (corpo.reasoning) {
        return new Response('{"error":{"message":"reasoning is not supported"}}', { status: 400 });
      }
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n');
    }) as unknown as typeof fetch;

    const resposta = await providerEm('https://openrouter.ai/api/v1', fetchImpl).complete(pedido);

    expect(corpos).toHaveLength(2);
    expect(corpos[1]).not.toHaveProperty('reasoning');
    expect(resposta.text).toBe('ok');
  });

  it('nao mascara um 400 que nao tem a ver com o parametro', async () => {
    let chamadas = 0;
    const fetchImpl = (async () => {
      chamadas += 1;
      return new Response('{"error":{"message":"context length exceeded"}}', { status: 400 });
    }) as unknown as typeof fetch;

    const erro = await providerEm('https://openrouter.ai/api/v1', fetchImpl)
      .complete(pedido)
      .catch((caught: unknown) => caught);

    expect(chamadas).toBe(1);
    expect(erro).toBeInstanceOf(ProviderError);
    expect((erro as ProviderError).message).toContain('context length exceeded');
  });
});
