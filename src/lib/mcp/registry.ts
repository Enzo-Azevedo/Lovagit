import type { ToolSchema } from '../ai/types';
import { assertRepoId } from '../storage';
import type { RepoId } from '../types';
import { authorizeServer, forgetServerAuth } from './auth';
import { McpClient } from './client';
import { hasHostPermission } from './permissions';
import { namespacedToolName } from './protocol';
import { McpError, type McpCallResult, type McpServerConfig, type McpToolInfo } from './types';

/**
 * Cadastro de servidores MCP.
 *
 * Regra de isolamento (definida com o usuario): o servidor e cadastrado uma vez
 * e habilitado por repositorio. Um chat so enxerga as ferramentas liberadas
 * para AQUELE repositorio — sem isso, um servidor MCP com memoria viraria um
 * canal lateral entre repositorios, por fora do firewall de contexto.
 */

const KEY = 'mcp:servers';

const clients = new Map<string, McpClient>();

function clientFor(config: McpServerConfig): McpClient {
  const existing = clients.get(config.id);
  if (existing) return existing;
  const client = new McpClient(config);
  clients.set(config.id, client);
  return client;
}

export async function getMcpServers(): Promise<McpServerConfig[]> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as McpServerConfig[] | undefined) ?? [];
}

async function writeServers(servers: McpServerConfig[]): Promise<McpServerConfig[]> {
  await chrome.storage.local.set({ [KEY]: servers });
  return servers;
}

export async function upsertMcpServer(config: McpServerConfig): Promise<McpServerConfig[]> {
  const servers = await getMcpServers();
  const index = servers.findIndex((server) => server.id === config.id);
  if (index === -1) return writeServers([...servers, config]);
  const next = [...servers];
  next[index] = config;
  return writeServers(next);
}

export async function removeMcpServer(serverId: string): Promise<McpServerConfig[]> {
  clients.delete(serverId);
  await forgetServerAuth(serverId);
  return writeServers((await getMcpServers()).filter((server) => server.id !== serverId));
}

export function createServerConfig(label: string, url: string): McpServerConfig {
  return {
    id: `mcp_${Date.now().toString(36)}`,
    label: label.trim() || new URL(url).hostname,
    url: url.trim(),
    // Nunca habilitado em repositorio nenhum por omissao.
    enabledRepoIds: [],
    tools: [],
    disabledTools: [],
  };
}

export async function setServerRepoEnabled(
  serverId: string,
  repoId: RepoId,
  enabled: boolean,
): Promise<McpServerConfig[]> {
  assertRepoId(repoId);
  const servers = await getMcpServers();
  return writeServers(
    servers.map((server) => {
      if (server.id !== serverId) return server;
      const set = new Set(server.enabledRepoIds);
      if (enabled) set.add(repoId);
      else set.delete(repoId);
      return { ...server, enabledRepoIds: [...set] };
    }),
  );
}

export async function setToolEnabled(
  serverId: string,
  toolName: string,
  enabled: boolean,
): Promise<McpServerConfig[]> {
  const servers = await getMcpServers();
  return writeServers(
    servers.map((server) => {
      if (server.id !== serverId) return server;
      const disabled = new Set(server.disabledTools);
      if (enabled) disabled.delete(toolName);
      else disabled.add(toolName);
      return { ...server, disabledTools: [...disabled] };
    }),
  );
}

/** Tira o repositorio de todos os servidores — usado ao desconectar um repo. */
export async function pruneRepoFromServers(repoId: RepoId): Promise<void> {
  const servers = await getMcpServers();
  await writeServers(
    servers.map((server) => ({
      ...server,
      enabledRepoIds: server.enabledRepoIds.filter((id) => id !== repoId),
    })),
  );
}

/** Servidores habilitados PARA ESTE repositorio. Nada mais atravessa. */
export async function getServersForRepo(repoId: RepoId): Promise<McpServerConfig[]> {
  assertRepoId(repoId);
  const servers = await getMcpServers();
  return servers.filter((server) => server.enabledRepoIds.includes(repoId));
}

/** Ferramentas MCP no formato que os provedores de IA entendem. */
export function mcpToolSchemas(servers: McpServerConfig[]): ToolSchema[] {
  return servers.flatMap((server) =>
    server.tools
      .filter((tool) => !server.disabledTools.includes(tool.name))
      .map((tool) => ({
        name: namespacedToolName(server.id, tool.name),
        description: `[${server.label}] ${tool.description}`.slice(0, 1000),
        inputSchema: tool.inputSchema,
      })),
  );
}

export interface ConnectResult {
  server: McpServerConfig;
  tools: McpToolInfo[];
}

/**
 * Conecta e descobre ferramentas. Em 401, dispara o consentimento OAuth (com
 * registro dinamico quando o servidor oferece) e tenta de novo — o usuario ve
 * apenas a pagina de autorizacao do provedor.
 */
export async function connectMcpServer(serverId: string): Promise<ConnectResult> {
  const servers = await getMcpServers();
  const config = servers.find((server) => server.id === serverId);
  if (!config) throw new McpError('Servidor nao encontrado.', serverId, 'protocol');

  // Antes de qualquer requisicao: sem a permissao de host, o navegador barra o
  // `fetch` por CORS e o erro que chega e' de transporte — o usuario leria
  // "servidor fora do ar" para um problema que e' de permissao, aqui dentro.
  if (!(await hasHostPermission(config.url))) {
    const message =
      `A extensao ainda nao tem permissao para acessar ${new URL(config.url).origin}. ` +
      'Clique em "Conectar" e aceite o pedido do navegador.';
    await upsertMcpServer({ ...config, lastError: message });
    throw new McpError(message, serverId, 'transport');
  }

  const client = clientFor(config);
  let tools: McpToolInfo[];
  let clientId = config.clientId;
  let requiresAuth = config.requiresAuth ?? false;

  try {
    tools = await client.connect();
  } catch (error) {
    if (error instanceof McpError && error.kind === 'unauthorized') {
      const hint = (error as McpError & { wwwAuthenticate?: string | null }).wwwAuthenticate ?? null;
      const authorized = await authorizeServer(serverId, config.url, hint, clientId);
      clientId = authorized.clientId;
      requiresAuth = true;
      tools = await client.connect();
    } else if (error instanceof McpError && error.kind === 'session-expired') {
      tools = await client.connect();
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await upsertMcpServer({ ...config, lastError: message });
      throw error;
    }
  }

  const updated: McpServerConfig = {
    ...config,
    tools,
    clientId,
    requiresAuth,
    lastConnectedAt: Date.now(),
    lastError: undefined,
  };
  await upsertMcpServer(updated);
  return { server: updated, tools };
}

/** Executa uma tool MCP. O chamador ja validou que o servidor vale para o repo. */
export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpCallResult> {
  if (server.disabledTools.includes(toolName)) {
    return { content: `A ferramenta ${toolName} esta desabilitada nas configuracoes.`, isError: true };
  }
  return clientFor(server).callTool(toolName, args, signal);
}
