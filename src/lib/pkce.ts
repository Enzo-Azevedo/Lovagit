/** Primitivas de PKCE (RFC 7636) compartilhadas pelos fluxos OAuth da extensao. */

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomVerifier(byteLength = 64): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function randomState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}
