import { describe, expect, it, vi } from 'vitest';
import { isWorthResuming, renderResumeHint, type PartialGeneration } from '../ai/partial';

/**
 * Quando o stream cai, tudo que o modelo ja tinha gerado era descartado e o
 * reenvio comecava do zero. Esses tokens ja foram cobrados — em modelo de
 * raciocinio, sao a parte cara da conta.
 */

function parcial(patch: Partial<PartialGeneration> = {}): PartialGeneration {
  return { text: '', reasoning: '', toolCalls: [], ...patch };
}

describe('vale a pena retomar?', () => {
  it('nada gerado nao vira retomada', () => {
    // Secao vazia so gasta contexto e confunde.
    expect(isWorthResuming(undefined)).toBe(false);
    expect(isWorthResuming(parcial())).toBe(false);
  });

  it('duas palavras tambem nao', () => {
    // Reconstruir isso e mais barato do que explicar que existiu.
    expect(isWorthResuming(parcial({ text: 'Vou ler' }))).toBe(false);
  });

  it('texto, raciocinio longo ou ferramenta em andamento valem', () => {
    expect(isWorthResuming(parcial({ text: 'a'.repeat(50) }))).toBe(true);
    expect(isWorthResuming(parcial({ reasoning: 'r'.repeat(250) }))).toBe(true);
    expect(
      isWorthResuming(parcial({ toolCalls: [{ name: 'write_file', partialArguments: '{"pa' }] })),
    ).toBe(true);
  });
});

describe('texto da retomada', () => {
  it('leva a resposta ja escrita', () => {
    const hint = renderResumeHint(parcial({ text: 'A funcao de login precisa validar o e-mail.' }));
    expect(hint).toContain('validar o e-mail');
    expect(hint).toContain('continue de onde parou');
  });

  it('do raciocinio leva o FIM, que e onde ele estava', () => {
    // O comeco arma o problema e o modelo reconstroi sozinho lendo o pedido; o
    // fim e o que diz para onde ele ia.
    const longo = `${'inicio '.repeat(400)}CONCLUSAO: usar o hook existente`;
    const hint = renderResumeHint(parcial({ reasoning: longo }));

    expect(hint).toContain('CONCLUSAO: usar o hook existente');
    expect(hint.length).toBeLessThan(longo.length);
  });

  it('a ferramenta cortada volta como TEXTO, avisando que nao esta completa', () => {
    // Argumento JSON cortado nao pode ser executado — viraria um write_file
    // com o arquivo truncado. Volta so como pista de onde ele tinha chegado.
    const hint = renderResumeHint(
      parcial({ toolCalls: [{ name: 'write_file', partialArguments: '{"path":"src/App.' }] }),
    );

    expect(hint).toContain('write_file');
    expect(hint).toContain('src/App.');
    expect(hint).toMatch(/CORTADO e nao foi executado/);
    expect(hint).toMatch(/refaca a chamada inteira/i);
  });

  it('corta o que e grande demais — aproveitar nao pode custar mais do que economiza', () => {
    const hint = renderResumeHint(
      parcial({ text: 'x'.repeat(50_000), reasoning: 'y'.repeat(50_000) }),
    );
    expect(hint.length).toBeLessThan(7000);
  });

  it('so mostra a secao do que existe', () => {
    const hint = renderResumeHint(parcial({ text: 'so texto aqui, nada de ferramenta' }));
    expect(hint).not.toContain('Ferramenta que ficou pela metade');
    expect(hint).not.toContain('Para onde o raciocinio ia');
  });
});

describe('o erro carrega o que foi gerado ate cair', () => {
  it('texto, raciocinio e a ferramenta pela metade viajam no ProviderError', async () => {
    // Sem isto o parcial morre no `throw` e o reenvio compra tudo de novo.
    const { createOpenAICompatibleProvider } = await import('../ai/openai-compatible');
    const { ProviderError } = await import('../ai/types');

    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"vou abrir o App"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Analisando o componente"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\\"path\\":\\"src/"}}]}}]}\n\n',
    ].join('');

    vi.stubGlobal('fetch', async () => {
      let etapa = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (etapa === 0) {
            etapa += 1;
            controller.enqueue(new TextEncoder().encode(sse));
            return;
          }
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(body, { status: 200 });
    });

    const provider = createOpenAICompatibleProvider({
      id: 'p1',
      label: 'Provedor',
      model: 'modelo-x',
      maxTokens: 100,
      baseUrl: 'https://exemplo.com/v1',
      getAuthToken: async () => 'chave',
    });

    const erro = (await provider
      .complete({ system: 's', turns: [{ role: 'user', text: 'oi' }], tools: [] })
      .catch((e: unknown) => e)) as InstanceType<typeof ProviderError>;

    expect(erro.partial?.text).toBe('Analisando o componente');
    expect(erro.partial?.reasoning).toContain('vou abrir o App');
    expect(erro.partial?.toolCalls).toEqual([
      { name: 'write_file', partialArguments: '{"path":"src/' },
    ]);
  });
});
