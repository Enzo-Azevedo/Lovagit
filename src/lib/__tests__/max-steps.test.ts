import { describe, expect, it } from 'vitest';
import { countPlanSteps, runAgent, type AgentEvent } from '../agent/loop';
import { createScope } from '../agent/isolation';
import type { AIProvider, CompletionResponse } from '../ai/types';
import type { RepoMap, RepoRef } from '../types';

/**
 * O teto de passos deixou de ser uma constante: o usuario configura o numero e
 * pode ligar o MAX STEPS dinamico, em que o modelo lista o plano antes de
 * executar e o teto vira a quantidade de itens da lista + 1.
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

describe('countPlanSteps', () => {
  it('conta lista numerada e marcadores', () => {
    expect(countPlanSteps('1. Ler o App\n2. Buscar o hook\n3) Escrever o ajuste')).toBe(3);
    expect(countPlanSteps('- Ler\n* Buscar\n+ Escrever')).toBe(3);
    expect(countPlanSteps('• Ler\n• Escrever')).toBe(2);
  });

  it('nao conta titulo, explicacao nem conclusao', () => {
    const plano = 'Vou fazer assim:\n1. Ler\n2. Escrever\nIsso resolve o problema.';
    expect(countPlanSteps(plano)).toBe(2);
  });

  it('texto sem lista nao gera passo nenhum', () => {
    expect(countPlanSteps('')).toBe(0);
    expect(countPlanSteps('Sem plano por aqui.')).toBe(0);
  });

  it('subitem nao vira passo', () => {
    // "1.1" nao tem espaco apos o "1." — e' detalhe do passo 1, nao passo novo.
    expect(countPlanSteps('1. Ler\n1.1 arquivo principal\n2. Escrever')).toBe(2);
  });
});

/** Provedor cuja primeira resposta e' o plano e as seguintes pedem tool. */
function provedorComPlano(
  plano: string,
  acoesSeguintes: Partial<CompletionResponse> = {},
) {
  let chamadas = 0;
  const provider: AIProvider = {
    id: 'p1',
    label: 'Provedor',
    model: 'modelo-x',
    complete: async () => {
      chamadas += 1;
      if (chamadas === 1) {
        return {
          text: plano,
          toolCalls: [],
          stopReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      return {
        text: '',
        toolCalls: [{ id: `c${chamadas}`, name: 'list_directory', input: { path: '' } }],
        stopReason: 'tool_calls',
        usage: { inputTokens: 0, outputTokens: 0 },
        ...acoesSeguintes,
      };
    },
  };
  return { provider, chamadas: () => chamadas };
}

async function runDynamic(provider: AIProvider, maxSteps = 100) {
  const events: AgentEvent[] = [];
  await runAgent({
    scope: createScope(repo),
    map,
    history: [],
    userText: 'ajuste o header',
    provider,
    autoApply: false,
    connectedRepoIds: ['acme/site'],
    mcpServers: [],
    memory: [],
    maxSteps,
    dynamicMaxSteps: true,
    onEvent: (event) => events.push(event),
  });
  return events;
}

describe('MAX STEPS dinamico', () => {
  it('lista o plano e usa itens + 1 como teto', async () => {
    const { provider, chamadas } = provedorComPlano('1. Ler\n2. Buscar\n3. Escrever');
    const events = await runDynamic(provider);

    const plano = events.find((event) => event.type === 'plan');
    expect(plano && 'text' in plano && plano.text).toContain('Escrever');

    // 1 chamada de plano + (3 itens + 1) passos do laco principal.
    expect(chamadas()).toBe(5);

    const erro = events.find((event) => event.type === 'error');
    expect(erro && 'error' in erro && erro.error).toMatch(/teto de 4 passos/i);
  });

  it('plano incontavel cai no teto configurado, sem derrubar o turno', async () => {
    // O modelo respondeu ao pedido do plano com texto que nao e' lista. Isso
    // nao pode matar o turno: o plano e' so uma forma de definir o teto.
    const { provider, chamadas } = provedorComPlano(
      'Vou direto ao ponto.',
      { text: 'feito', toolCalls: [] },
    );
    const events = await runDynamic(provider, 5);

    const plano = events.find((event) => event.type === 'plan');
    expect(plano && 'text' in plano && plano.text).toBe('Vou direto ao ponto.');
    // Plano + 1 passo que encerra com texto final.
    expect(chamadas()).toBe(2);
    expect(events.find((event) => event.type === 'error')).toBeUndefined();
  });
});
