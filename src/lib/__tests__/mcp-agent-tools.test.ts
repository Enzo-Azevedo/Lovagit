import { describe, expect, it, vi } from 'vitest';
import { ContextIsolationError, createScope } from '../agent/isolation';
import type { McpServerConfig } from '../mcp/types';
import type { PendingFileChange, RepoMap, RepoRef, ToolCall } from '../types';

const callMcpTool = vi.hoisted(() =>
  vi.fn(async (_server: unknown, tool: string, args: Record<string, unknown>) => ({
    content: `resultado de ${tool} com ${JSON.stringify(args)}`,
    isError: false,
  })),
);

vi.mock('../mcp/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp/registry')>()),
  callMcpTool,
}));

const { buildToolSchemas, executeTool } = await import('../agent/tools');

const repo: RepoRef = {
  id: 'acme/site',
  owner: 'acme',
  name: 'site',
  defaultBranch: 'main',
  private: false,
  htmlUrl: 'https://github.com/acme/site',
};

function mcpServer(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv1',
    label: 'Banco',
    url: 'https://exemplo.com/mcp',
    enabledRepoIds: ['acme/site'],
    tools: [{ name: 'query', description: 'Consulta', inputSchema: { type: 'object', properties: {} } }],
    disabledTools: [],
    ...patch,
  };
}

function runtime(mcpServers: McpServerConfig[]) {
  return {
    scope: createScope(repo),
    map: { repoId: 'acme/site', entries: [], headSha: 'sha' } as unknown as RepoMap,
    mcpServers,
    ref: 'sha',
    pending: new Map<string, PendingFileChange>(),
    autoApply: false,
    onPendingChanged: () => {},
    onCommitted: async () => {},
    onAwaitingApproval: () => {},
  };
}

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { id: 'c1', name, input };
}

describe('buildToolSchemas', () => {
  it('soma as tools nativas com as do MCP habilitado', () => {
    const names = buildToolSchemas([mcpServer()]).map((tool) => tool.name);
    expect(names).toContain('read_file');
    expect(names).toContain('mcp__srv1__query');
  });

  it('sem servidor habilitado, o agente so ve as tools nativas', () => {
    expect(buildToolSchemas([]).every((tool) => !tool.name.startsWith('mcp__'))).toBe(true);
  });
});

describe('executeTool — ferramentas MCP', () => {
  it('executa a tool do servidor habilitado para o repositorio', async () => {
    const result = await executeTool(runtime([mcpServer()]), call('mcp__srv1__query', { sql: 'select 1' }));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('resultado de query');
    expect(callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'srv1' }),
      'query',
      { sql: 'select 1' },
      undefined,
    );
  });

  it('recusa tool de servidor que nao esta na lista do repositorio', async () => {
    const result = await executeTool(runtime([]), call('mcp__outro__query'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('nao esta habilitado');
  });

  it('deixa a falha de isolamento ESCALAR em vez de virar erro de tool', async () => {
    // Servidor presente na lista, mas sem este repositorio habilitado: isso so
    // acontece se o filtro por repositorio falhou — e defeito, nao erro de uso.
    const contaminated = mcpServer({ enabledRepoIds: ['acme/api'] });
    await expect(
      executeTool(runtime([contaminated]), call('mcp__srv1__query')),
    ).rejects.toBeInstanceOf(ContextIsolationError);
  });

  it('rejeita nome de tool MCP malformado', async () => {
    const result = await executeTool(runtime([mcpServer()]), call('mcp__semseparador'));
    expect(result.isError).toBe(true);
  });
});
