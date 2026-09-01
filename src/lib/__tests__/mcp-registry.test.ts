import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../mcp/types';

const store = new Map<string, unknown>();
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
      remove: async () => {},
    },
  },
});

const {
  getMcpServers,
  getServersForRepo,
  mcpToolSchemas,
  pruneRepoFromServers,
  setServerRepoEnabled,
  setToolEnabled,
  upsertMcpServer,
  createServerConfig,
} = await import('../mcp/registry');

function server(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv1',
    label: 'Banco',
    url: 'https://exemplo.com/mcp',
    enabledRepoIds: [],
    tools: [
      { name: 'query', description: 'Consulta o banco', inputSchema: { type: 'object', properties: {} } },
      { name: 'drop', description: 'Apaga tabela', inputSchema: { type: 'object', properties: {} } },
    ],
    disabledTools: [],
    ...patch,
  };
}

beforeEach(() => store.clear());

describe('createServerConfig', () => {
  it('nasce sem repositorio habilitado — isolamento e o padrao', () => {
    expect(createServerConfig('', 'https://exemplo.com/mcp').enabledRepoIds).toEqual([]);
  });

  it('usa o hostname quando o nome vem vazio', () => {
    expect(createServerConfig('  ', 'https://exemplo.com/mcp').label).toBe('exemplo.com');
  });
});

describe('escopo por repositorio', () => {
  it('so devolve servidores habilitados para o repositorio pedido', async () => {
    await upsertMcpServer(server({ id: 'a', enabledRepoIds: ['acme/site'] }));
    await upsertMcpServer(server({ id: 'b', enabledRepoIds: ['acme/api'] }));

    expect((await getServersForRepo('acme/site')).map((s) => s.id)).toEqual(['a']);
    expect((await getServersForRepo('acme/api')).map((s) => s.id)).toEqual(['b']);
  });

  it('repositorio sem nenhum servidor habilitado nao ve ferramenta alguma', async () => {
    await upsertMcpServer(server({ id: 'a', enabledRepoIds: ['acme/site'] }));
    expect(await getServersForRepo('acme/outro')).toEqual([]);
  });

  it('habilitar e desabilitar por repositorio nao afeta os demais', async () => {
    await upsertMcpServer(server({ id: 'a', enabledRepoIds: ['acme/site', 'acme/api'] }));
    await setServerRepoEnabled('a', 'acme/api', false);

    const [saved] = await getMcpServers();
    expect(saved.enabledRepoIds).toEqual(['acme/site']);
  });

  it('rejeita repoId malformado antes de gravar', async () => {
    await upsertMcpServer(server({ id: 'a' }));
    await expect(setServerRepoEnabled('a', '../etc', true)).rejects.toThrow(/repoId invalido/);
  });

  it('desconectar um repositorio o remove de todos os servidores', async () => {
    await upsertMcpServer(server({ id: 'a', enabledRepoIds: ['acme/site', 'acme/api'] }));
    await upsertMcpServer(server({ id: 'b', enabledRepoIds: ['acme/site'] }));

    await pruneRepoFromServers('acme/site');

    const saved = await getMcpServers();
    expect(saved.map((s) => s.enabledRepoIds)).toEqual([['acme/api'], []]);
  });
});

describe('mcpToolSchemas', () => {
  it('expoe as ferramentas com namespace e rotulo do servidor', () => {
    const [tool] = mcpToolSchemas([server({ id: 'srv1', tools: [server().tools[0]] })]);
    expect(tool.name).toBe('mcp__srv1__query');
    expect(tool.description).toContain('[Banco]');
  });

  it('omite ferramenta desabilitada', async () => {
    await upsertMcpServer(server({ id: 'a', enabledRepoIds: ['acme/site'] }));
    await setToolEnabled('a', 'drop', false);

    const names = mcpToolSchemas(await getServersForRepo('acme/site')).map((tool) => tool.name);
    expect(names).toEqual(['mcp__a__query']);
  });
});
