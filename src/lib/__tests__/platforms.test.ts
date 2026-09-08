import { describe, expect, it, vi } from 'vitest';
import { platformById, platformForMcpUrl, PLATFORMS } from '../platforms/types';
import { checkSupabaseToken } from '../platforms/supabase';

/**
 * O Supabase tem token pessoal igual ao do GitHub: `sbp_...`, emitido no painel
 * da conta, enviado em `Authorization: Bearer` para a Management API em
 * `api.supabase.com`. Verificado contra a API real — `/v1/projects` responde
 * 401 sem token e aceita o PAT.
 */

describe('definicoes de plataforma', () => {
  it('o Supabase aponta para a Management API e para onde emitir o token', () => {
    const supabase = platformById('supabase');
    expect(supabase?.apiOrigin).toBe('https://api.supabase.com');
    expect(supabase?.tokenPrefix).toBe('sbp_');
    expect(supabase?.createUrl).toContain('supabase.com');
  });

  it('toda plataforma diz o alcance do token — nao e decoracao', () => {
    // Token de plataforma costuma ser mais poderoso do que parece: o do
    // Supabase, sem escopo, tem os privilegios da conta inteira.
    for (const plataforma of PLATFORMS) {
      expect(plataforma.scopeWarning.length).toBeGreaterThan(20);
    }
  });
});

describe('token da plataforma reaproveitado no MCP', () => {
  it('reconhece o servidor MCP do proprio servico', () => {
    // E' o que evita cadastrar a mesma credencial duas vezes.
    expect(platformForMcpUrl('https://mcp.supabase.com/mcp')?.id).toBe('supabase');
    expect(platformForMcpUrl('https://MCP.SUPABASE.COM/mcp')?.id).toBe('supabase');
  });

  it('nao empresta o token para servidor de terceiro', () => {
    // Casar por sufixo entregaria o token a `mcp.supabase.com.evil.test`.
    expect(platformForMcpUrl('https://mcp.supabase.com.evil.test/mcp')).toBeUndefined();
    expect(platformForMcpUrl('https://exemplo.com/mcp')).toBeUndefined();
    expect(platformForMcpUrl('nao e uma url')).toBeUndefined();
  });
});

describe('teste do token do Supabase', () => {
  it('token valido responde com os projetos que ele enxerga', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(String(url)).toBe('https://api.supabase.com/v1/projects');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sbp_abc');
        return new Response(JSON.stringify([{ name: 'loja' }, { name: 'blog' }]), { status: 200 });
      }),
    );

    const check = await checkSupabaseToken('  sbp_abc  ');
    expect(check.ok).toBe(true);
    expect(check.projects).toEqual(['blog', 'loja']);
    expect(check.message).toContain('2 projeto');
  });

  it('401 diz que o token foi recusado, em vez de repetir o corpo cru', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    const check = await checkSupabaseToken('sbp_revogado');
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/recusado/i);
  });

  it('conta sem projeto e valida, nao e erro', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    const check = await checkSupabaseToken('sbp_nova');
    expect(check.ok).toBe(true);
    expect(check.projects).toEqual([]);
  });

  it('falha de rede aponta a permissao de host, que e a causa comum', async () => {
    // Sem a permissao, o navegador barra antes de a requisicao sair e devolve
    // um "Failed to fetch" com cara de servidor fora do ar.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const check = await checkSupabaseToken('sbp_abc');
    expect(check.ok).toBe(false);
    expect(check.message).toContain('permissao');
    expect(check.message).toContain('https://api.supabase.com');
  });
});
