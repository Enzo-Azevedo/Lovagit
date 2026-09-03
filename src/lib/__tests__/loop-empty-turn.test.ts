import { describe, expect, it } from 'vitest';
import { historyToTurns, runAgent, type AgentEvent } from '../agent/loop';
import { createScope } from '../agent/isolation';
import type { AIProvider, CompletionResponse } from '../ai/types';
import type { RepoMap, RepoRef } from '../types';

/**
 * Regressao: com um modelo que encerra sem texto e sem tool call, a conversa
 * simplesmente parava na tela — sem resposta, sem erro, sem explicacao.
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

function providerReturning(response: Partial<CompletionResponse>): AIProvider {
  return {
    id: 'p1',
    label: 'Provedor',
    model: 'modelo-x',
    complete: async () => ({
      text: '',
      toolCalls: [],
      stopReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
      ...response,
    }),
  };
}

async function run(provider: AIProvider) {
  const events: AgentEvent[] = [];
  const messages = await runAgent({
    scope: createScope(repo),
    map,
    history: [],
    userText: 'leia o repositorio e me faca um resumo',
    provider,
    autoApply: false,
    connectedRepoIds: ['acme/site'],
    mcpServers: [],
    memory: [],
    onEvent: (event) => events.push(event),
  });
  return { events, messages };
}

describe('turno vazio', () => {
  it('avisa quando o modelo encerra sem resposta nem ferramenta', async () => {
    const { events } = await run(providerReturning({}));

    const erro = events.find((event) => event.type === 'error');
    expect(erro, 'a conversa nao pode parar em silencio').toBeDefined();
    expect(erro && 'error' in erro && erro.error).toContain('sem produzir resposta');
  });

  it('mostra o raciocinio quando e a unica coisa que o modelo devolveu', async () => {
    const { events, messages } = await run(
      providerReturning({ reasoning: 'preciso ler mais arquivos antes de responder' }),
    );

    // O raciocinio fica no campo proprio, para a interface poder mostra-lo no
    // lugar cronologico; o conteudo so explica por que nao veio resposta.
    const assistente = messages.find((message) => message.role === 'assistant');
    expect(assistente?.reasoning).toContain('preciso ler mais arquivos');
    expect(assistente?.content).toContain('nao produziu resposta final');

    const erro = events.find((event) => event.type === 'error');
    expect(erro && 'error' in erro && erro.error).toContain('apenas raciocinio');
  });

  it('nao avisa nada quando o modelo responde normalmente', async () => {
    const { events } = await run(providerReturning({ text: 'aqui vai o resumo do repositorio' }));
    expect(events.find((event) => event.type === 'error')).toBeUndefined();
  });
});

describe('raciocinio por passo', () => {
  it('fica na mensagem do passo, ao lado da resposta', async () => {
    const { messages } = await run(
      providerReturning({ text: 'pronto', reasoning: 'vou olhar o header primeiro' }),
    );

    const assistente = messages.find((message) => message.role === 'assistant');
    expect(assistente?.reasoning).toBe('vou olhar o header primeiro');
    expect(assistente?.content).toBe('pronto');
  });

  it('nao guarda raciocinio quando o modelo nao mandou nenhum', async () => {
    const { messages } = await run(providerReturning({ text: 'pronto' }));
    expect(messages.find((message) => message.role === 'assistant')?.reasoning).toBeUndefined();
  });

  it('trunca raciocinio gigante — ele e para ler, nao para encher o storage', async () => {
    const { messages } = await run(
      providerReturning({ text: 'pronto', reasoning: 'p'.repeat(50_000) }),
    );

    const raciocinio = messages.find((m) => m.role === 'assistant')?.reasoning ?? '';
    expect(raciocinio.length).toBeLessThan(5000);
    expect(raciocinio).toContain('truncado');
  });

  it('NAO reenvia o raciocinio ao modelo', () => {
    // Reenviar dobraria o custo do historico sem ajudar: o modelo ja sabe o que
    // pensou, e alguns provedores recusam o campo de volta.
    const turnos = historyToTurns([
      { id: '1', repoId: 'acme/site', role: 'user', content: 'ajuste o header', createdAt: 0 },
      {
        id: '2',
        repoId: 'acme/site',
        role: 'assistant',
        content: 'feito',
        reasoning: 'PENSAMENTO_QUE_NAO_PODE_VOLTAR',
        createdAt: 1,
      },
    ]);

    expect(JSON.stringify(turnos)).not.toContain('PENSAMENTO_QUE_NAO_PODE_VOLTAR');
  });
});
