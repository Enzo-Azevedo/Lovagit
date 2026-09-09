import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpUrlForPlatform } from '../platforms/access';

/**
 * O botao que cadastra o servidor MCP da plataforma. O que se verifica aqui e'
 * o recorte: a URL e' o unico lugar onde a restricao vale de verdade, porque
 * ela e' o servidor recusando, e nao o prompt pedindo.
 */

describe('mcpUrlForPlatform', () => {
  it('prende o servidor ao projeto escolhido', () => {
    const url = new URL(mcpUrlForPlatform('supabase', 'refdoprojeto') ?? '');
    expect(url.origin + url.pathname).toBe('https://mcp.supabase.com/mcp');
    expect(url.searchParams.get('project_ref')).toBe('refdoprojeto');
  });

  it('nasce somente leitura', () => {
    // Escrita acidental em banco de producao nao tem desfazer; afrouxar depois
    // e um clique.
    expect(new URL(mcpUrlForPlatform('supabase', 'r') ?? '').searchParams.get('read_only')).toBe(
      'true',
    );
  });

  it('da para pedir escrita explicitamente', () => {
    const url = new URL(mcpUrlForPlatform('supabase', 'r', { readOnly: false }) ?? '');
    expect(url.searchParams.get('read_only')).toBeNull();
    expect(url.searchParams.get('project_ref')).toBe('r');
  });

  it('plataforma desconhecida devolve null em vez de URL chutada', () => {
    expect(mcpUrlForPlatform('nao-existe' as never, 'r')).toBeNull();
  });
});

describe('registerPlatformServer', () => {
  const store = new Map<string, unknown>();
  beforeEach(() => store.clear());
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        remove: async () => {},
      },
    },
  });

  it('habilita SO para o repositorio atual', async () => {
    // Habilitar para todos abriria o canal lateral entre repositorios que a
    // extensao existe para impedir — e aqui o vazamento seria de dado de
    // producao, nao de contexto de conversa.
    const { registerPlatformServer, getMcpServers } = await import('../mcp/registry');

    const config = await registerPlatformServer('supabase', 'acme/site', 'refdoprojeto');

    expect(config.enabledRepoIds).toEqual(['acme/site']);
    expect(config.url).toContain('project_ref=refdoprojeto');
    expect(config.url).toContain('read_only=true');

    const salvos = await getMcpServers();
    expect(salvos).toHaveLength(1);
    expect(salvos[0].enabledRepoIds).toEqual(['acme/site']);
  });

  it('recusa identificador de repositorio invalido', async () => {
    const { registerPlatformServer } = await import('../mcp/registry');
    await expect(registerPlatformServer('supabase', 'sem-barra' as never, 'r')).rejects.toThrow();
  });
});
