import type { McpToolInfo } from './types';

/**
 * Partes puras do protocolo MCP sobre Streamable HTTP. Ficam separadas do
 * transporte para poderem ser testadas sem rede.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id?: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export function request(id: number, method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

export function notification(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
}

/**
 * O servidor escolhe o enquadramento: JSON puro ou SSE (`data: {...}`). Um
 * cliente que so entende JSON quebra em metade dos servidores.
 */
export function parseRpcBody<T>(body: string): JsonRpcResponse<T> | null {
  const trimmed = body.trim();
  if (trimmed === '') return null;

  if (!trimmed.startsWith('data:') && !trimmed.includes('\ndata:')) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse<T>;
    } catch {
      return null;
    }
  }

  // SSE: pega o ultimo evento `data:` que contenha uma resposta JSON-RPC.
  let last: JsonRpcResponse<T> | null = null;
  for (const line of trimmed.split('\n')) {
    const clean = line.trim();
    if (!clean.startsWith('data:')) continue;
    const payload = clean.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse<T>;
      if (parsed.result !== undefined || parsed.error !== undefined) last = parsed;
    } catch {
      // Evento parcial ou keep-alive: ignora.
    }
  }
  return last;
}

/** Garante um JSON Schema de objeto — alguns servidores mandam schema solto. */
export function normalizeToolSchema(schema: unknown): McpToolInfo['inputSchema'] {
  const candidate = (schema ?? {}) as Record<string, unknown>;
  const properties =
    typeof candidate.properties === 'object' && candidate.properties !== null
      ? (candidate.properties as Record<string, unknown>)
      : {};
  return {
    type: 'object',
    properties,
    ...(Array.isArray(candidate.required) ? { required: candidate.required as string[] } : {}),
  };
}

/** `mcp__<servidor>__<tool>`: evita colisao com as tools nativas do agente. */
export function namespacedToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

export function parseNamespacedToolName(
  name: string,
): { serverId: string; toolName: string } | null {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!match) return null;
  return { serverId: match[1], toolName: match[2] };
}

/** Achata o `content` do resultado em texto — o que o modelo consegue ler. */
export function flattenToolContent(result: unknown): string {
  const payload = result as
    | { content?: { type: string; text?: string; [key: string]: unknown }[]; isError?: boolean }
    | undefined;
  const blocks = payload?.content ?? [];
  const parts = blocks.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'resource') return JSON.stringify(block.resource ?? block);
    return `[bloco ${block.type} nao textual omitido]`;
  });
  return parts.join('\n').trim() || '(resposta vazia)';
}
