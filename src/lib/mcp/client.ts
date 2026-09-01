import { getAccessToken } from './auth';
import {
  flattenToolContent,
  normalizeToolSchema,
  notification,
  parseRpcBody,
  request,
} from './protocol';
import { McpError, PREFERRED_PROTOCOL_VERSION, type McpCallResult, type McpServerConfig, type McpToolInfo } from './types';

/**
 * Cliente MCP sobre Streamable HTTP.
 *
 * Roda direto do side panel: paginas de extensao ignoram CORS para hosts em
 * `host_permissions`, entao servidor que nao libera nossa origem funciona do
 * mesmo jeito — o que nao aconteceria numa pagina web comum.
 */
export class McpClient {
  private sessionId: string | null = null;
  private protocolVersion = PREFERRED_PROTOCOL_VERSION;
  private nextId = 1;
  private initialized = false;

  constructor(private readonly config: Pick<McpServerConfig, 'id' | 'url'>) {}

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // O servidor escolhe o enquadramento; precisamos aceitar os dois.
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const token = await getAccessToken(this.config.id);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private async post<T>(
    message: ReturnType<typeof request> | ReturnType<typeof notification>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.config.url, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify(message),
        signal,
      });
    } catch (error) {
      throw new McpError(
        `Nao foi possivel alcancar o servidor: ${error instanceof Error ? error.message : String(error)}`,
        this.config.id,
        'transport',
      );
    }

    if (response.status === 401) {
      const err = new McpError('O servidor exige autorizacao.', this.config.id, 'unauthorized');
      // Guarda a dica de descoberta para o fluxo OAuth nao ter que adivinhar.
      (err as McpError & { wwwAuthenticate?: string | null }).wwwAuthenticate =
        response.headers.get('www-authenticate');
      throw err;
    }

    if (response.status === 404 && this.sessionId) {
      this.sessionId = null;
      this.initialized = false;
      throw new McpError('A sessao expirou no servidor.', this.config.id, 'session-expired');
    }

    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new McpError(
        `Servidor respondeu ${response.status}: ${detail.slice(0, 200) || response.statusText}`,
        this.config.id,
        'transport',
      );
    }

    const body = await response.text();
    // Notificacao aceita volta 202/204 sem corpo — sucesso, nao erro de parse.
    if (message.id === undefined) return undefined as T;

    const parsed = parseRpcBody<T>(body);
    if (!parsed) {
      throw new McpError('Resposta do servidor nao e JSON-RPC valido.', this.config.id, 'protocol');
    }
    if (parsed.error) {
      throw new McpError(
        `${parsed.error.message} (codigo ${parsed.error.code})`,
        this.config.id,
        'protocol',
      );
    }
    return parsed.result as T;
  }

  /** Handshake + descoberta de ferramentas. */
  async connect(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const result = await this.post<{
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    }>(
      request(this.nextId++, 'initialize', {
        protocolVersion: PREFERRED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Lovagit', version: chrome.runtime.getManifest?.().version ?? '0.0.0' },
      }),
      signal,
    );

    // O servidor pode responder com outra versao: negociacao normal.
    if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;

    await this.post(notification('notifications/initialized'), signal);
    this.initialized = true;

    return this.listTools(signal);
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const result = await this.post<{
      tools?: { name: string; description?: string; inputSchema?: unknown }[];
    }>(request(this.nextId++, 'tools/list', {}), signal);

    return (result?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: normalizeToolSchema(tool.inputSchema),
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    if (!this.initialized) await this.connect(signal);
    const result = await this.post<{ content?: unknown[]; isError?: boolean }>(
      request(this.nextId++, 'tools/call', { name, arguments: args }),
      signal,
    );
    return {
      content: flattenToolContent(result),
      isError: Boolean(result?.isError),
    };
  }

  /** Encerramento e best-effort: servidor que recusa DELETE nao e problema. */
  async disconnect(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.config.url, { method: 'DELETE', headers: await this.headers() });
    } catch {
      // Sessao sera coletada pelo servidor de qualquer forma.
    }
    this.sessionId = null;
    this.initialized = false;
  }
}
