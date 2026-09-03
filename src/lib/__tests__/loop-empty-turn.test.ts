import { describe, expect, it } from 'vitest';
import { runAgent, type AgentEvent } from '../agent/loop';
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

    const assistente = messages.find((message) => message.role === 'assistant');
    expect(assistente?.content).toContain('preciso ler mais arquivos');
    expect(assistente?.content).toContain('nao produziu resposta final');

    const erro = events.find((event) => event.type === 'error');
    expect(erro && 'error' in erro && erro.error).toContain('apenas raciocinio');
  });

  it('nao avisa nada quando o modelo responde normalmente', async () => {
    const { events } = await run(providerReturning({ text: 'aqui vai o resumo do repositorio' }));
    expect(events.find((event) => event.type === 'error')).toBeUndefined();
  });
});
