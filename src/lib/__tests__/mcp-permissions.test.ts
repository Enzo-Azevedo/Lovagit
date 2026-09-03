import { describe, expect, it, vi } from 'vitest';

const contains = vi.fn(async () => true);
const request = vi.fn(async () => true);
vi.stubGlobal('chrome', { permissions: { contains, request } });

const { hasHostPermission, originPatternFor, requestHostPermission } = await import(
  '../mcp/permissions'
);

describe('originPatternFor', () => {
  it('reduz a URL do servidor a origem — permissao e por origem, nao por caminho', () => {
    expect(originPatternFor('https://mcp.supabase.com/mcp')).toBe('https://mcp.supabase.com/*');
    expect(originPatternFor('https://exemplo.com/a/b?c=1#d')).toBe('https://exemplo.com/*');
    expect(originPatternFor('https://exemplo.com:8443/mcp')).toBe('https://exemplo.com:8443/*');
  });

  it('devolve null em vez de montar padrao invalido', () => {
    expect(originPatternFor('nao e uma url')).toBeNull();
    expect(originPatternFor('')).toBeNull();
  });
});

describe('requestHostPermission', () => {
  it('NAO consulta antes de pedir — a consulta gastaria o gesto do usuario', async () => {
    // `chrome.permissions.request` so vale dentro do gesto do clique, e qualquer
    // await antes dele encerra o gesto. Um `contains` de cortesia aqui faria o
    // pedido ser recusado pelo navegador — foi por isso que a conexao com o
    // servidor MCP nunca funcionou.
    contains.mockClear();
    request.mockClear();

    await expect(requestHostPermission('https://mcp.supabase.com/mcp')).resolves.toBe(true);

    expect(contains).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith({ origins: ['https://mcp.supabase.com/*'] });
  });

  it('URL invalida nao vira pedido de permissao', async () => {
    request.mockClear();
    await expect(requestHostPermission('nao e uma url')).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('hasHostPermission', () => {
  it('consulta sem pedir — serve para explicar a falha, nao para abrir dialogo', async () => {
    contains.mockClear();
    request.mockClear();

    await expect(hasHostPermission('https://exemplo.com/mcp')).resolves.toBe(true);

    expect(contains).toHaveBeenCalledWith({ origins: ['https://exemplo.com/*'] });
    expect(request).not.toHaveBeenCalled();
  });
});
