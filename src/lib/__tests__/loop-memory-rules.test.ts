import { describe, expect, it } from 'vitest';
import { runAgent, type AgentEvent } from '../agent/loop';
import { createScope } from '../agent/isolation';
import type { AIProvider, CompletionResponse } from '../ai/types';
import type { RepoMap, RepoRef } from '../types';

/**
 * A regra dita pelo usuario tem que virar memoria sozinha. Sem isto, guardar
 * algo dependia de o usuario pedir "adicione na memoria" — e o que ele diz de
 * passagem ("sempre use aspas simples") se perdia no fim do turno.
 */

const repo: RepoRef = {
  id: 'acme/site',
  owner: 'acme',
  name: 'site',
  defaultBranch: 'main',
  private: false,
  htmlUrl: 'https://github.com/acme/site',
};

const map: RepoMap = {
  repoId: 'acme/site',
  defaultBranch: 'main',
  headSha: 'abc123',
  generatedAt: 0,
  entries: [{ path: 'src/index.ts', type: 'blob', sha: '1' }],
  truncated: false,
  languages: { TypeScript: 100 },
  stack: ['TypeScript'],
  entryPoints: ['src/index.ts'],
  highlights: [],
  fileCount: 1,
  dirCount: 1,
};

/** Provedor que devolve uma resposta por passo, na ordem. */
function providerRespondendo(...respostas: Partial<CompletionResponse>[]): AIProvider {
  let passo = 0;
  return {
    id: 'p1',
    label: 'Provedor',
    model: 'modelo-x',
    complete: async () => ({
      text: '',
      toolCalls: [],
      stopReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
      ...(respostas[Math.min(passo++, respostas.length - 1)] ?? {}),
    }),
  };
}

async function run(userText: string, provider: AIProvider) {
  const events: AgentEvent[] = [];
  await runAgent({
    scope: createScope(repo),
    map,
    history: [],
    userText,
    provider,
    autoApply: false,
    connectedRepoIds: ['acme/site'],
    mcpServers: [],
    memory: [],
    onEvent: (event) => events.push(event),
  });
  return events.flatMap((event) => (event.type === 'memory' ? [event.entry] : []));
}

describe('regra do usuario vira memoria sem ser pedida', () => {
  it('grava mesmo em turno que nao mexeu em arquivo nenhum', async () => {
    // Este e' o caso que se perdia: definir uma convencao nao muda arquivo hoje,
    // e e' exatamente o que precisa continuar valendo amanha.
    const memorias = await run(
      'sempre use aspas simples neste projeto',
      providerRespondendo({ text: 'combinado' }),
    );

    expect(memorias).toHaveLength(1);
    expect(memorias[0].kind).toBe('decision');
    expect(memorias[0].summary).toContain('aspas simples');
  });

  it('guarda so a frase da regra, com a mensagem inteira no detalhe', async () => {
    const memorias = await run(
      'Me explica o App.tsx. E nunca commite direto na main.',
      providerRespondendo({ text: 'o App.tsx monta a home' }),
    );

    expect(memorias[0].summary).toBe('E nunca commite direto na main.');
    expect(memorias[0].detail).toContain('Me explica o App.tsx');
  });

  it('pergunta comum continua nao gravando nada', async () => {
    const memorias = await run(
      'o que o App.tsx faz?',
      providerRespondendo({ text: 'ele monta a home' }),
    );
    expect(memorias).toEqual([]);
  });

  it('quando o modelo mesmo registra, o detector se cala — nada duplicado', async () => {
    // A porta principal continua sendo o `remember`: o resumo dele e' melhor
    // que qualquer recorte de texto, e duas entradas para o mesmo fato so
    // gastam a janela de contexto das conversas seguintes.
    const memorias = await run(
      'sempre use aspas simples neste projeto',
      providerRespondendo(
        {
          toolCalls: [
            {
              id: 'c1',
              name: 'remember',
              input: { summary: 'Estilo: aspas simples em todo o codigo' },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'anotado' },
      ),
    );

    expect(memorias).toHaveLength(1);
    expect(memorias[0].summary).toBe('Estilo: aspas simples em todo o codigo');
  });
});
