import { challengeFor, randomState, randomVerifier } from '../pkce';
import { getSecret, SecretNames, setSecret, deleteSecret } from '../vault';
import { McpError } from './types';

/**
 * Autorizacao de servidor MCP — o login de um clique que o usuario queria.
 *
 * O padrao MCP resolve o problema que a Anthropic nao resolve para a API dela:
 * o cliente descobre o authorization server pelos metadados (RFC 9728), se
 * registra sozinho (RFC 7591 Dynamic Client Registration) e faz PKCE. Nenhum
 * `client_id` digitado a mao, nenhum cadastro previo — o usuario so autoriza na
 * pagina do provedor.
 */

interface ProtectedResourceMetadata {
  authorization_servers?: string[];
  resource?: string;
}

interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface McpAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes: string[];
  /** Identificador do recurso (RFC 8707), exigido pelo fluxo do MCP. */
  resource: string;
}

interface StoredMcpTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** `WWW-Authenticate: Bearer resource_metadata="https://..."` */
export function parseResourceMetadataUrl(header: string | null): string | null {
  if (!header) return null;
  const match = /resource_metadata="([^"]+)"/i.exec(header);
  return match ? match[1] : null;
}

/**
 * Descobre os endpoints de autorizacao a partir da URL do servidor MCP.
 * A ordem segue a especificacao: dica do WWW-Authenticate, depois metadados do
 * recurso protegido, depois metadados do authorization server.
 */
export async function discoverAuthEndpoints(
  serverUrl: string,
  wwwAuthenticate: string | null,
): Promise<McpAuthEndpoints> {
  const resource = new URL(serverUrl);
  const origin = resource.origin;

  const resourceMetadataUrl =
    parseResourceMetadataUrl(wwwAuthenticate) ??
    `${origin}/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`;

  const resourceMetadata =
    (await fetchJson<ProtectedResourceMetadata>(resourceMetadataUrl)) ??
    (await fetchJson<ProtectedResourceMetadata>(`${origin}/.well-known/oauth-protected-resource`));

  const authServer = resourceMetadata?.authorization_servers?.[0] ?? origin;
  const authServerUrl = new URL(authServer);

  // RFC 8414 insere o `.well-known` antes do path; o OIDC usa o sufixo.
  const candidates = [
    `${authServerUrl.origin}/.well-known/oauth-authorization-server${authServerUrl.pathname === '/' ? '' : authServerUrl.pathname}`,
    `${authServerUrl.origin}/.well-known/openid-configuration${authServerUrl.pathname === '/' ? '' : authServerUrl.pathname}`,
    `${authServer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
    `${authServer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  ];

  let metadata: AuthServerMetadata | null = null;
  for (const candidate of candidates) {
    metadata = await fetchJson<AuthServerMetadata>(candidate);
    if (metadata?.authorization_endpoint && metadata.token_endpoint) break;
    metadata = null;
  }

  if (!metadata?.authorization_endpoint || !metadata.token_endpoint) {
    throw new McpError(
      'O servidor exige autenticacao, mas nao publica metadados OAuth (RFC 9728/8414). ' +
        'Sem isso nao da para fazer login automatico.',
      serverUrl,
      'unauthorized',
    );
  }

  return {
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint,
    scopes: metadata.scopes_supported ?? [],
    resource: resourceMetadata?.resource ?? `${origin}${resource.pathname}`,
  };
}

/** Registro dinamico (RFC 7591): o cliente publico obtem um client_id sozinho. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Lovagit',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new McpError(
      `Registro dinamico recusado (${response.status}): ${detail.slice(0, 200)}`,
      registrationEndpoint,
      'unauthorized',
    );
  }
  const registration = (await response.json()) as { client_id?: string };
  if (!registration.client_id) {
    throw new McpError('Registro dinamico nao devolveu client_id.', registrationEndpoint, 'unauthorized');
  }
  return registration.client_id;
}

async function exchange(
  endpoints: McpAuthEndpoints,
  clientId: string,
  body: Record<string, string>,
): Promise<StoredMcpTokens> {
  const response = await fetch(endpoints.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...body, client_id: clientId, resource: endpoints.resource }).toString(),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new McpError(
      `Token endpoint respondeu ${response.status}: ${raw.slice(0, 200)}`,
      endpoints.tokenEndpoint,
      'unauthorized',
    );
  }
  const parsed = JSON.parse(raw) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!parsed.access_token) {
    throw new McpError('Resposta sem access_token.', endpoints.tokenEndpoint, 'unauthorized');
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : undefined,
    clientId,
  };
}

export interface AuthorizeResult {
  clientId: string;
}

/**
 * Fluxo completo: descoberta -> registro (se preciso) -> consentimento -> token.
 * O usuario ve apenas a pagina de autorizacao do provedor.
 */
export async function authorizeServer(
  serverId: string,
  serverUrl: string,
  wwwAuthenticate: string | null,
  existingClientId?: string,
): Promise<AuthorizeResult> {
  const redirectUri = chrome.identity.getRedirectURL();
  const endpoints = await discoverAuthEndpoints(serverUrl, wwwAuthenticate);

  let clientId = existingClientId;
  if (!clientId) {
    if (!endpoints.registrationEndpoint) {
      throw new McpError(
        'O servidor nao oferece registro dinamico de cliente. Informe um client_id ' +
          'manualmente nas configuracoes do servidor.',
        serverId,
        'unauthorized',
      );
    }
    clientId = await registerClient(endpoints.registrationEndpoint, redirectUri);
  }

  const verifier = randomVerifier();
  const state = randomState();
  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', await challengeFor(verifier));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  // RFC 8707: amarra o token a este servidor MCP especifico.
  authUrl.searchParams.set('resource', endpoints.resource);
  if (endpoints.scopes.length > 0) authUrl.searchParams.set('scope', endpoints.scopes.join(' '));

  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!redirectResponse) throw new McpError('Login cancelado.', serverId, 'unauthorized');

  const params = new URL(redirectResponse).searchParams;
  if (params.get('error')) {
    throw new McpError(
      `Autorizacao recusada: ${params.get('error_description') ?? params.get('error')}`,
      serverId,
      'unauthorized',
    );
  }
  if (params.get('state') !== state) {
    throw new McpError('State do OAuth nao confere — login abortado.', serverId, 'unauthorized');
  }
  const code = params.get('code');
  if (!code) throw new McpError('O provedor nao devolveu authorization code.', serverId, 'unauthorized');

  const tokens = await exchange(endpoints, clientId, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  await setSecret(
    SecretNames.mcpOAuth(serverId),
    JSON.stringify({ tokens, endpoints } satisfies StoredAuth),
  );
  return { clientId };
}

interface StoredAuth {
  tokens: StoredMcpTokens;
  endpoints: McpAuthEndpoints;
}

async function readStoredAuth(serverId: string): Promise<StoredAuth | null> {
  const raw = await getSecret(SecretNames.mcpOAuth(serverId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredAuth;
  } catch {
    return null;
  }
}

/** Token valido para o servidor, renovando quando o provedor permite. */
export async function getAccessToken(serverId: string): Promise<string | null> {
  const stored = await readStoredAuth(serverId);
  if (!stored) return null;

  const expiringSoon =
    stored.tokens.expiresAt !== undefined && stored.tokens.expiresAt - Date.now() < 60_000;
  if (!expiringSoon) return stored.tokens.accessToken;

  if (!stored.tokens.refreshToken) return null;
  try {
    const refreshed = await exchange(stored.endpoints, stored.tokens.clientId, {
      grant_type: 'refresh_token',
      refresh_token: stored.tokens.refreshToken,
    });
    const merged: StoredAuth = {
      endpoints: stored.endpoints,
      tokens: { ...refreshed, refreshToken: refreshed.refreshToken ?? stored.tokens.refreshToken },
    };
    await setSecret(SecretNames.mcpOAuth(serverId), JSON.stringify(merged));
    return merged.tokens.accessToken;
  } catch {
    return null;
  }
}

export async function forgetServerAuth(serverId: string): Promise<void> {
  await deleteSecret(SecretNames.mcpOAuth(serverId));
}
