import { describe, expect, it } from 'vitest';
import { parseResourceMetadataUrl } from '../mcp/auth';

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
