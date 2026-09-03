import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Origens liberadas neste teste. E' o que decide cada `hasHostPermission`. */
const liberadas = new Set<string>();
vi.stubGlobal('chrome', {
  permissions: {
    contains: async ({ origins }: { origins: string[] }) =>
      origins.every((origem) => liberadas.has(origem)),
  },
});

/** Respostas por URL. O que nao estiver aqui responde 404. */
const respostas = new Map<string, unknown>();
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string) => {
    const corpo = respostas.get(String(url));
    return corpo === undefined
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify(corpo), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
  }),
);

const { discoverAuthEndpoints, parseResourceMetadataUrl, pickAuthMethod } = await import(
  '../mcp/auth'
);
const { McpError } = await import('../mcp/types');

/** O caso real: o servidor MCP e o login moram em dominios diferentes. */
const MCP = 'https://mcp.supabase.com/mcp';
const PRM = 'https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp';
const AS_META = 'https://api.supabase.com/.well-known/oauth-authorization-server';
const CABECALHO = `Bearer error="invalid_request", resource_metadata="${PRM}"`;

beforeEach(() => {
  liberadas.clear();
  respostas.clear();
  respostas.set(PRM, {
    resource: MCP,
    authorization_servers: ['https://api.supabase.com'],
  });
  respostas.set(AS_META, {
    issuer: 'https://api.supabase.com',
    authorization_endpoint: 'https://api.supabase.com/v1/oauth/authorize',
    token_endpoint: 'https://api.supabase.com/v1/oauth/token',
    registration_endpoint: 'https://api.supabase.com/platform/oauth/apps/register',
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  });
});

describe('parseResourceMetadataUrl', () => {
  it('extrai a dica de descoberta do WWW-Authenticate', () => {
    const header =
      'Bearer error="invalid_token", resource_metadata="https://exemplo.com/.well-known/oauth-protected-resource/mcp"';
    expect(parseResourceMetadataUrl(header)).toBe(
      'https://exemplo.com/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('devolve null quando o header nao traz a dica', () => {
    expect(parseResourceMetadataUrl('Bearer realm="api"')).toBeNull();
    expect(parseResourceMetadataUrl(null)).toBeNull();
  });
});

describe('discoverAuthEndpoints', () => {
  it('para e diz qual origem falta quando o login mora em outro dominio', async () => {
    // Este era o erro que o usuario via: o `fetch` para api.supabase.com levava
    // um CORS, `fetchJson` engolia, e a extensao acusava "o servidor nao publica
    // metadados OAuth" — sobre um servidor que publica tudo.
    liberadas.add('https://mcp.supabase.com/*');

    const erro = await discoverAuthEndpoints(MCP, CABECALHO).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(McpError);
    expect((erro as InstanceType<typeof McpError>).kind).toBe('needs-permission');
    expect((erro as InstanceType<typeof McpError>).origin).toBe('https://api.supabase.com');
  });

  it('cobra tambem a origem dos metadados do recurso', async () => {
    // Sem nenhuma permissao, a primeira consulta ja para — e nomeia o proprio
    // servidor, que e' o que o usuario precisa liberar primeiro.
    const erro = await discoverAuthEndpoints(MCP, CABECALHO).catch((e: unknown) => e);
    expect((erro as InstanceType<typeof McpError>).origin).toBe('https://mcp.supabase.com');
  });

  it('com as duas origens liberadas, descobre os endpoints', async () => {
    liberadas.add('https://mcp.supabase.com/*');
    liberadas.add('https://api.supabase.com/*');

    const endpoints = await discoverAuthEndpoints(MCP, CABECALHO);

    expect(endpoints.authorizationEndpoint).toBe('https://api.supabase.com/v1/oauth/authorize');
    expect(endpoints.tokenEndpoint).toBe('https://api.supabase.com/v1/oauth/token');
    expect(endpoints.resource).toBe(MCP);
    expect(endpoints.tokenAuthMethods).toContain('client_secret_post');
  });
});

describe('pickAuthMethod', () => {
  it('prefere cliente publico quando o servidor aceita', () => {
    expect(pickAuthMethod(['none', 'client_secret_post'])).toBe('none');
    // Servidor que nao anuncia nada: o padrao do OAuth e' cliente publico.
    expect(pickAuthMethod([])).toBe('none');
  });

  it('aceita segredo quando `none` nao esta na lista', () => {
    // O do Supabase e' assim. Pedir `none` a quem nao aceita fazia o registro
    // passar e a troca do token falhar depois com `invalid_client`.
    expect(pickAuthMethod(['client_secret_basic', 'client_secret_post'])).toBe(
      'client_secret_post',
    );
    expect(pickAuthMethod(['client_secret_basic'])).toBe('client_secret_basic');
  });
});
