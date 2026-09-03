import { useCallback, useEffect, useState } from 'react';
import {
  connectMcpServer,
  createServerConfig,
  getMcpServers,
  removeMcpServer,
  setServerRepoEnabled,
  setToolEnabled,
  upsertMcpServer,
} from '../lib/mcp/registry';
import type { McpServerConfig } from '../lib/mcp/types';
import { getSettings } from '../lib/storage';
import type { RepoId } from '../lib/types';

const inputClass =
  'w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ink-200 outline-none placeholder:text-ink-600 focus:border-ink-600';
const primaryButton =
  'rounded-md bg-gradient-to-r from-lov-orange to-lov-pink px-3 py-1.5 text-xs font-medium text-lov-ink disabled:opacity-40';
const ghostButton = 'rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200';

export function McpSection() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [repoIds, setRepoIds] = useState<RepoId[]>([]);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setServers(await getMcpServers());
    setRepoIds((await getSettings()).connectedRepoIds);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const connect = useCallback(
    async (serverId: string) => {
      setBusyId(serverId);
      setMessage(null);
      try {
        const { tools } = await connectMcpServer(serverId);
        setMessage(`Conectado — ${tools.length} ferramenta(s) descoberta(s).`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyId(null);
        await reload();
      }
    },
    [reload],
  );

  const add = useCallback(async () => {
    let config: McpServerConfig;
    try {
      config = createServerConfig(label, url);
    } catch {
      setMessage('URL invalida.');
      return;
    }
    if (!/^https:\/\//i.test(config.url)) {
      setMessage('Use uma URL https — o navegador bloqueia http em extensao.');
      return;
    }
    await upsertMcpServer(config);
    setLabel('');
    setUrl('');
    await reload();
    await connect(config.id);
  }, [connect, label, reload, url]);

  return (
    <section className="space-y-3 rounded-lg border border-ink-700 bg-ink-900 p-4">
      <h2 className="text-sm text-ink-200">6. Servidores MCP (ferramentas extras)</h2>
      <p className="text-[11px] text-ink-400">
        Servidores MCP dao ferramentas ao agente — consultar um banco, ler um projeto, abrir um
        chamado. Eles nao substituem o provedor de IA: o modelo continua vindo da chave configurada
        acima. A conexao usa o login do proprio provedor: descoberta de metadados, registro dinamico
        de cliente e consentimento na pagina dele, sem client_id digitado a mao.
      </p>

      <div className="grid grid-cols-[1fr_2fr_auto] gap-2">
        <input
          className={inputClass}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Nome (opcional)"
        />
        <input
          className={inputClass}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://exemplo.com/mcp"
        />
        <button className={primaryButton} disabled={!url.trim()} onClick={() => void add()}>
          Adicionar e conectar
        </button>
      </div>

      {message && (
        <p className="rounded-md border border-ink-700 bg-ink-800 px-3 py-2 text-[11px] text-ink-200">
          {message}
        </p>
      )}

      {servers.length === 0 && (
        <p className="text-[11px] text-ink-400">Nenhum servidor MCP cadastrado.</p>
      )}

      {servers.map((server) => (
        <div key={server.id} className="space-y-2 rounded-md border border-ink-700 bg-ink-950 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs text-ink-200">
                {server.label}
                {server.requiresAuth && (
                  <span className="ml-2 rounded bg-ink-800 px-1 text-[10px] text-ink-400">
                    autenticado
                  </span>
                )}
              </p>
              <p className="truncate font-mono text-[10px] text-ink-400">{server.url}</p>
              <p className="text-[10px] text-ink-400">
                {server.lastError
                  ? `Erro: ${server.lastError}`
                  : server.lastConnectedAt
                    ? `${server.tools.length} ferramenta(s) · conectado em ${new Date(server.lastConnectedAt).toLocaleString('pt-BR')}`
                    : 'Nunca conectado'}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                className={ghostButton}
                disabled={busyId === server.id}
                onClick={() => void connect(server.id)}
              >
                {busyId === server.id ? 'Conectando...' : 'Reconectar'}
              </button>
              <button
                className="rounded-md px-2 py-1.5 text-xs text-red-300 hover:underline"
                onClick={() => void removeMcpServer(server.id).then(reload)}
              >
                Remover
              </button>
            </div>
          </div>

          <div>
            <p className="mb-1 text-[11px] text-ink-200">Habilitado nos repositorios</p>
            {repoIds.length === 0 ? (
              <p className="text-[10px] text-ink-400">
                Conecte um repositorio no painel lateral para poder habilitar aqui.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {repoIds.map((repoId) => (
                  <label key={repoId} className="flex items-center gap-1 text-[11px] text-ink-400">
                    <input
                      type="checkbox"
                      checked={server.enabledRepoIds.includes(repoId)}
                      onChange={(event) =>
                        void setServerRepoEnabled(server.id, repoId, event.target.checked).then(
                          reload,
                        )
                      }
                    />
                    {repoId}
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 text-[10px] text-ink-400">
              O chat de um repositorio so enxerga as ferramentas marcadas para ele — e assim que o
              MCP nao vira um atalho entre repositorios.
            </p>
          </div>

          {server.tools.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px] text-ink-400">
                Ferramentas ({server.tools.length})
              </summary>
              <div className="mt-1 space-y-1">
                {server.tools.map((tool) => (
                  <label key={tool.name} className="flex items-start gap-2 text-[11px] text-ink-400">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={!server.disabledTools.includes(tool.name)}
                      onChange={(event) =>
                        void setToolEnabled(server.id, tool.name, event.target.checked).then(reload)
                      }
                    />
                    <span>
                      <code className="text-ink-200">{tool.name}</code>
                      {tool.description && <> — {tool.description.slice(0, 140)}</>}
                    </span>
                  </label>
                ))}
              </div>
            </details>
          )}
        </div>
      ))}
    </section>
  );
}
