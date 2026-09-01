import type { OAuthProviderConfig } from '../types';
import { getSecret, SecretNames, setSecret, deleteSecret } from '../vault';
import { ProviderError } from './types';

/**
 * Login OAuth 2.0 com PKCE (RFC 7636) em um provedor terceiro.
 *
 * A extensao e' um *public client*: nao existe client_secret embutido — ele
 * vazaria no bundle. O PKCE cobre exatamente esse caso. O redirect usado e' o
 * `https://<extension-id>.chromiumapp.org/`, que o `chrome.identity` intercepta
 * sem nunca abrir uma pagina de verdade.
 */

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Ausente = token sem expiracao declarada. */
  expiresAt?: number;
  tokenType: string;
  scope?: string;
}

export function getRedirectUri(): string {
  return chrome.identity.getRedirectURL();
}

function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

async function exchange(
  config: OAuthProviderConfig,
  body: Record<string, string>,
): Promise<StoredTokens> {
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new ProviderError(`Token endpoint respondeu ${response.status}: ${raw.slice(0, 300)}`);
  }
  let parsed: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Alguns provedores respondem application/x-www-form-urlencoded.
    parsed = Object.fromEntries(new URLSearchParams(raw));
  }
  if (parsed.error || !parsed.access_token) {
    throw new ProviderError(
      `Falha no OAuth: ${parsed.error_description ?? parsed.error ?? 'sem access_token na resposta'}`,
    );
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : undefined,
    tokenType: parsed.token_type ?? 'Bearer',
    scope: parsed.scope,
  };
}

/** Abre a janela de consentimento e guarda os tokens no cofre. */
export async function loginWithOAuth(config: OAuthProviderConfig): Promise<StoredTokens> {
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = getRedirectUri();

  const authUrl = new URL(config.authorizationUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  if (config.scopes.length > 0) authUrl.searchParams.set('scope', config.scopes.join(' '));
  for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
    authUrl.searchParams.set(key, value);
  }

  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!redirectResponse) throw new ProviderError('Login cancelado.');

  const returned = new URL(redirectResponse);
  const params = returned.searchParams.has('code')
    ? returned.searchParams
    : new URLSearchParams(returned.hash.replace(/^#/, ''));

  if (params.get('error')) {
    throw new ProviderError(
      `Provedor recusou o login: ${params.get('error_description') ?? params.get('error')}`,
    );
  }
  if (params.get('state') !== state) {
    throw new ProviderError('State do OAuth nao confere — login abortado por seguranca.');
  }
  const code = params.get('code');
  if (!code) throw new ProviderError('O provedor nao devolveu um authorization code.');

  const tokens = await exchange(config, {
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  await setSecret(SecretNames.providerOAuth(config.id), JSON.stringify(tokens));
  return tokens;
}

export async function getStoredTokens(providerId: string): Promise<StoredTokens | null> {
  const raw = await getSecret(SecretNames.providerOAuth(providerId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export async function logoutOAuth(providerId: string): Promise<void> {
  await deleteSecret(SecretNames.providerOAuth(providerId));
}

/** Devolve um access token valido, renovando com refresh_token quando possivel. */
export async function getValidAccessToken(config: OAuthProviderConfig): Promise<string> {
  const tokens = await getStoredTokens(config.id);
  if (!tokens) throw new ProviderError(`Faca login em ${config.label} nas configuracoes.`);

  const expiringSoon = tokens.expiresAt !== undefined && tokens.expiresAt - Date.now() < 60_000;
  if (!expiringSoon) return tokens.accessToken;

  if (!tokens.refreshToken) {
    throw new ProviderError(`A sessao em ${config.label} expirou. Faca login novamente.`);
  }
  const refreshed = await exchange(config, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: config.clientId,
  });
  const merged: StoredTokens = {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
  };
  await setSecret(SecretNames.providerOAuth(config.id), JSON.stringify(merged));
  return merged.accessToken;
}
