import { describe, expect, it } from 'vitest';
import {
  flattenToolContent,
  namespacedToolName,
  normalizeToolSchema,
  parseNamespacedToolName,
  parseRpcBody,
} from '../mcp/protocol';

describe('parseRpcBody', () => {
  it('entende resposta JSON pura', () => {
    const parsed = parseRpcBody<{ tools: [] }>('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
    expect(parsed?.result).toEqual({ tools: [] });
  });

  it('entende resposta em SSE — metade dos servidores responde assim', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"x"}]}}\n\n';
    const parsed = parseRpcBody<{ tools: { name: string }[] }>(body);
    expect(parsed?.result?.tools[0].name).toBe('x');
  });

  it('ignora keep-alive e pega o ultimo evento com resultado', () => {
    const body = [
      ': ping',
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      'data: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}',
    ].join('\n');
    expect(parseRpcBody<{ ok: boolean }>(body)?.result).toEqual({ ok: true });
  });

  it('propaga erro JSON-RPC em vez de tratar como sucesso', () => {
    const parsed = parseRpcBody('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nao existe"}}');
    expect(parsed?.error?.code).toBe(-32601);
  });

  it('devolve null para corpo vazio ou invalido', () => {
    expect(parseRpcBody('')).toBeNull();
    expect(parseRpcBody('<html>proxy</html>')).toBeNull();
  });
});

describe('normalizeToolSchema', () => {
  it('completa schema faltante em vez de quebrar', () => {
    expect(normalizeToolSchema(undefined)).toEqual({ type: 'object', properties: {} });
    expect(normalizeToolSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
  });
});

describe('nomes de tool com namespace', () => {
  it('faz ida e volta preservando ids com underscore', () => {
    const name = namespacedToolName('mcp_abc123', 'query_database');
    expect(parseNamespacedToolName(name)).toEqual({
      serverId: 'mcp_abc123',
      toolName: 'query_database',
    });
  });

  it('nao casa com as tools nativas do agente', () => {
    expect(parseNamespacedToolName('read_file')).toBeNull();
    expect(parseNamespacedToolName('commit_changes')).toBeNull();
  });
});

describe('flattenToolContent', () => {
  it('junta blocos de texto', () => {
    expect(
      flattenToolContent({ content: [{ type: 'text', text: 'linha 1' }, { type: 'text', text: 'linha 2' }] }),
    ).toBe('linha 1\nlinha 2');
  });

  it('sinaliza bloco nao textual em vez de sumir com ele', () => {
    expect(flattenToolContent({ content: [{ type: 'image', data: 'xxx' }] })).toContain('nao textual');
  });

  it('nao devolve string vazia', () => {
    expect(flattenToolContent({ content: [] })).toBe('(resposta vazia)');
  });
});
