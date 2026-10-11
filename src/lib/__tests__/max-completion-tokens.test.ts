import { describe, expect, it, vi } from 'vitest';
import {
  acceptsMaxCompletionTokens,
  createOpenAICompatibleProvider,
} from '../ai/openai-compatible';
import { ProviderError } from '../ai/types';

/**
 * Modelos de raciocinio da OpenAI (o1/o3/gpt-5) recusam `max_tokens` e exigem
 * `max_completion_tokens`; o restante do ecossistema compativel ainda usa
 * `max_tokens`. O cliente aposta pelo host e, se errar, refaz a chamada com o
 * nome alternativo — um extra nosso nunca pode impedir a conversa de sair.
 */

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

function corpoDo(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('acceptsMaxCompletionTokens', () => {
  it('so reconhece o dominio da OpenAI', () => {
    expect(acceptsMaxCompletionTokens('https://api.openai.com/v1/chat/completions')).toBe(true);
    expect(acceptsMaxCompletionTokens('https://openai.com/v1')).toBe(true);
    expect(acceptsMaxCompletionTokens('https://api.openrouter.ai/api/v1/chat/completions')).toBe(false);
    expect(acceptsMaxCompletionTokens('https://api.groq.com/openai/v1/chat/completions')).toBe(false);
    expect(acceptsMaxCompletionTokens('https://exemplo.com/v1')).toBe(false);
    // Host que apenas termina parecido nao pode passar por OpenAI.
    expect(acceptsMaxCompletionTokens('https://naoopenai.com/v1')).toBe(false);
    expect(acceptsMaxCompletionTokens('https://openai.com.exemplo.com/v1')).toBe(false);
    expect(acceptsMaxCompletionTokens('nao e uma url')).toBe(false);
  });
});

describe('nome do parametro de limite de tokens', () => {
  it('usa max_completion_tokens na OpenAI e max_tokens nos demais', async () => {
    const corpos: Record<string, unknown>[] = [];
    const espiao = (async (_url: string, init: RequestInit) => {
      corpos.push(corpoDo(init));
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n');
    }) as unknown as typeof fetch;

    await providerEm('https://api.openai.com/v1', espiao).complete(pedido);
    await providerEm('https://exemplo.com/v1', espiao).complete(pedido);

    expect(corpos[0]).toHaveProperty('max_completion_tokens', 100);
    expect(corpos[0]).not.toHaveProperty('max_tokens');
    expect(corpos[1]).toHaveProperty('max_tokens', 100);
    expect(corpos[1]).not.toHaveProperty('max_completion_tokens');
  });

  it('refaz com max_completion_tokens quando o endpoint recusa max_tokens', async () => {
    const corpos: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const corpo = corpoDo(init);
      corpos.push(corpo);
      if ('max_tokens' in corpo) {
        return new Response(
          '{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead."}}',
          { status: 400 },
        );
      }
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n');
    }) as unknown as typeof fetch;

    const resposta = await providerEm('https://exemplo.com/v1', fetchImpl).complete(pedido);

    expect(corpos).toHaveLength(2);
    expect(corpos[0]).toHaveProperty('max_tokens');
    expect(corpos[1]).toHaveProperty('max_completion_tokens');
    expect(corpos[1]).not.toHaveProperty('max_tokens');
    expect(resposta.text).toBe('ok');
  });

  it('refaz com max_tokens quando a OpenAI recusa max_completion_tokens', async () => {
    const corpos: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const corpo = corpoDo(init);
      corpos.push(corpo);
      if ('max_completion_tokens' in corpo) {
        return new Response(
          '{"error":{"message":"Unsupported parameter: \'max_completion_tokens\'."}}',
          { status: 400 },
        );
      }
      return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n');
    }) as unknown as typeof fetch;

    const resposta = await providerEm('https://api.openai.com/v1', fetchImpl).complete(pedido);

    expect(corpos).toHaveLength(2);
    expect(corpos[0]).toHaveProperty('max_completion_tokens');
    expect(corpos[1]).toHaveProperty('max_tokens');
    expect(corpos[1]).not.toHaveProperty('max_completion_tokens');
    expect(resposta.text).toBe('ok');
  });

  it('nao mascara um 400 que nao tem a ver com o parametro de tokens', async () => {
    let chamadas = 0;
    const fetchImpl = (async () => {
      chamadas += 1;
      return new Response('{"error":{"message":"context length exceeded"}}', { status: 400 });
    }) as unknown as typeof fetch;

    const erro = await providerEm('https://api.openai.com/v1', fetchImpl)
      .complete(pedido)
      .catch((caught: unknown) => caught);

    expect(chamadas).toBe(1);
    expect(erro).toBeInstanceOf(ProviderError);
    expect((erro as ProviderError).message).toContain('context length exceeded');
  });
});
