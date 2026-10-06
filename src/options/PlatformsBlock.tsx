import { useCallback, useEffect, useState } from 'react';
import { requestHostPermission } from '../lib/mcp/permissions';
import { checkSupabaseToken } from '../lib/platforms/supabase';
import {
  getPlatformConnections,
  getPlatformLinks,
  getPlatformToken,
  setPlatformToken,
  setRepoProjectRef,
  updatePlatformConnection,
} from '../lib/platforms/store';
import { getSettings } from '../lib/storage';
import type { RepoId } from '../lib/types';
import { mcpUrlForPlatform, serverForPlatformInRepo } from '../lib/platforms/access';
import { PLATFORMS, type PlatformConnection, type PlatformId } from '../lib/platforms/types';
import { connectMcpServer, getMcpServers, registerPlatformServer } from '../lib/mcp/registry';
import type { McpServerConfig } from '../lib/mcp/types';

const inputClass =
  'w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ink-200 outline-none placeholder:text-ink-600 focus:border-ink-600';
const primaryButton =
  'rounded-md bg-gradient-to-r from-lov-orange to-lov-pink px-3 py-1.5 text-xs font-medium text-lov-ink disabled:opacity-40';
const ghostButton = 'rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200';

/**
 * Plataformas conhecidas: so falta o token.
 *
 * O token e' testado na hora de salvar, contra a API da propria plataforma.
 * Guardar credencial sem testar repete o defeito que ja mordeu na chave do
 * provedor de IA — a pessoa descobre que errou muito depois, num erro que fala
 * de outra coisa.
 */
export function PlatformsBlock({ onMessage }: { onMessage: (texto: string | null) => void }) {
  const [conexoes, setConexoes] = useState<PlatformConnection[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [revelado, setRevelado] = useState<Record<string, boolean>>({});
  const [ocupado, setOcupado] = useState<PlatformId | null>(null);
  const [repoIds, setRepoIds] = useState<RepoId[]>([]);
  /** plataforma -> repositorio -> ref do projeto. */
  const [links, setLinks] = useState<Record<string, Record<string, string>>>({});
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);

  const reload = useCallback(async () => {
    const lista = await getPlatformConnections();
    setConexoes(lista);
    const tokens = await Promise.all(
      lista.map(async (conexao) => [conexao.id, (await getPlatformToken(conexao.id)) ?? ''] as const),
    );
    setDrafts(Object.fromEntries(tokens));
    setRepoIds((await getSettings()).connectedRepoIds);
    setLinks(await getPlatformLinks());
    setMcpServers(await getMcpServers());
  }, []);

  const vincular = useCallback(
    async (platformId: PlatformId, repoId: RepoId, ref: string) => {
      await setRepoProjectRef(platformId, repoId, ref || null);
      setLinks(await getPlatformLinks());
    },
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Cadastra o servidor MCP da plataforma para ESTE repositorio e ja conecta.
   *
   * A permissao de host e' o primeiro `await` do clique: o Chrome so aceita
   * `permissions.request` dentro do gesto do usuario, e qualquer espera antes
   * dele encerra o gesto. A URL sai pronta antes disso justamente por isso —
   * ela e' calculada de dados que ja estao na tela.
   */
  const cadastrarServidor = useCallback(
    async (id: PlatformId, repoId: RepoId, projectRef: string) => {
      const url = mcpUrlForPlatform(id, projectRef);
      if (!url) return;

      if (!(await requestHostPermission(url))) {
        onMessage(`Sem permissão para ${new URL(url).origin} — o servidor não teria como conectar.`);
        return;
      }

      setOcupado(id);
      onMessage(null);
      try {
        const config = await registerPlatformServer(id, repoId, projectRef);
        const { tools } = await connectMcpServer(config.id);
        onMessage(
          `Servidor cadastrado para ${repoId} e conectado — ${tools.length} ferramenta(s), ` +
            'somente leitura, preso a este projeto.',
        );
      } catch (erro) {
        onMessage(erro instanceof Error ? erro.message : String(erro));
      } finally {
        setOcupado(null);
        await reload();
      }
    },
    [onMessage, reload],
  );

  const salvar = useCallback(
    async (id: PlatformId) => {
      const plataforma = PLATFORMS.find((item) => item.id === id);
      const token = (drafts[id] ?? '').trim();

      // Primeiro await do clique: `permissions.request` exige o gesto do
      // usuario, e qualquer await antes dele ja encerra o gesto.
      if (token && plataforma && !(await requestHostPermission(plataforma.apiOrigin))) {
        onMessage(
          `Sem permissão para ${plataforma.apiOrigin} — o token não tem como ser verificado nem usado.`,
        );
        return;
      }

      setOcupado(id);
      onMessage(null);
      try {
        const guardado = await setPlatformToken(id, token);
        if (!guardado) {
          onMessage('Token removido.');
          return;
        }
        const check = await checkSupabaseToken(token);
        await updatePlatformConnection(id, {
          lastCheck: check.ok ? check.message : undefined,
          lastCheckedAt: check.ok ? Date.now() : undefined,
          lastError: check.ok ? undefined : check.message,
          // A lista fica guardada para a tela oferecer as opcoes sem bater na
          // API a cada render.
          projects: check.ok ? check.projects : undefined,
        });
        onMessage(check.message);
      } finally {
        setOcupado(null);
        await reload();
      }
    },
    [drafts, onMessage, reload],
  );

  return (
    <div className="space-y-2">
      <h3 className="text-xs text-ink-200">Plataformas</h3>
      {PLATFORMS.map((plataforma) => {
        const conexao = conexoes.find((item) => item.id === plataforma.id);
        const rascunho = drafts[plataforma.id] ?? '';
        const prefixoEstranho =
          rascunho.trim().length > 0 && !rascunho.trim().startsWith(plataforma.tokenPrefix);

        return (
          <div
            key={plataforma.id}
            className="space-y-2 rounded-md border border-ink-700 bg-ink-950 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-ink-200">
                {plataforma.label}
                {conexao?.hasToken && (
                  <span className="ml-2 rounded bg-ink-800 px-1 text-[10px] text-ink-400">
                    token salvo
                  </span>
                )}
              </p>
              <a
                className="text-[10px] text-lov-orange hover:underline"
                href={plataforma.createUrl}
                target="_blank"
                rel="noreferrer"
              >
                Emitir token →
              </a>
            </div>

            <div className="flex gap-2">
              <input
                type={revelado[plataforma.id] ? 'text' : 'password'}
                className={inputClass}
                value={rascunho}
                placeholder={`${plataforma.tokenLabel} (${plataforma.tokenPrefix}...)`}
                onChange={(event) =>
                  setDrafts((prev) => ({ ...prev, [plataforma.id]: event.target.value }))
                }
              />
              <button
                className={ghostButton}
                onClick={() =>
                  setRevelado((prev) => ({ ...prev, [plataforma.id]: !prev[plataforma.id] }))
                }
              >
                {revelado[plataforma.id] ? 'Ocultar' : 'Mostrar'}
              </button>
              <button
                className={primaryButton}
                disabled={ocupado === plataforma.id}
                onClick={() => void salvar(plataforma.id)}
              >
                {ocupado === plataforma.id ? 'Verificando...' : 'Salvar e testar'}
              </button>
            </div>

            {prefixoEstranho && (
              <p className="text-[10px] text-ink-400">
                Um token do {plataforma.label} começa com <code>{plataforma.tokenPrefix}</code> — o
                que está aí parece ser outra credencial.
              </p>
            )}

            {conexao?.lastError && <p className="text-[10px] text-red-300">{conexao.lastError}</p>}
            {conexao?.lastCheck && !conexao.lastError && (
              <p className="text-[10px] text-ink-400">{conexao.lastCheck}</p>
            )}

            <p className="text-[10px] text-ink-400">
              {plataforma.scopeWarning} Fica no cofre cifrado, e serve também para o servidor MCP do
              próprio {plataforma.label} — sem precisar cadastrar duas vezes.
            </p>

            {conexao?.hasToken && (
              <div className="space-y-1 border-t border-ink-800 pt-2">
                <p className="text-[11px] text-ink-200">Projeto de cada repositório</p>
                {repoIds.length === 0 ? (
                  <p className="text-[10px] text-ink-400">
                    Conecte um repositório no painel lateral para poder vincular aqui.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {repoIds.map((repoId) => {
                      const escolhido = links[plataforma.id]?.[repoId] ?? '';
                      return (
                        <div key={repoId} className="grid grid-cols-[1fr_1.2fr] items-center gap-2">
                          <span className="truncate font-mono text-[10px] text-ink-400">
                            {repoId}
                          </span>
                          <div className="space-y-0.5">
                          <select
                            className={`rounded-md border bg-ink-950 px-2 py-1 text-[11px] outline-none ${
                              escolhido
                                ? 'border-ink-700 text-ink-200'
                                : 'border-lov-orange/40 text-ink-400'
                            }`}
                            value={escolhido}
                            onChange={(event) =>
                              void vincular(plataforma.id, repoId, event.target.value)
                            }
                          >
                            <option value="">Nenhum — a IA não verá este serviço</option>
                            {(conexao.projects ?? []).map((projeto) => (
                              <option key={projeto.ref} value={projeto.ref}>
                                {projeto.name}
                                {projeto.region ? ` (${projeto.region})` : ''}
                              </option>
                            ))}
                          </select>
                          {escolhido &&
                            !serverForPlatformInRepo(plataforma.id, repoId, mcpServers) && (
                              <div className="space-y-1 rounded-md border border-lov-orange/30 bg-lov-orange/10 p-2">
                                <p className="text-[10px] text-lov-orange">
                                  Vinculado, mas sem servidor MCP do {plataforma.label} habilitado
                                  para este repositório — a IA sabe do projeto e não tem como
                                  acessá-lo.
                                </p>
                                <button
                                  className={primaryButton}
                                  disabled={ocupado === plataforma.id}
                                  onClick={() =>
                                    void cadastrarServidor(plataforma.id, repoId, escolhido)
                                  }
                                >
                                  {ocupado === plataforma.id
                                    ? 'Cadastrando...'
                                    : 'Cadastrar servidor MCP para este repositório'}
                                </button>
                                <p className="text-[10px] text-ink-400">
                                  Cria o servidor preso a este projeto (<code>project_ref</code>) e
                                  em somente leitura (<code>read_only</code>), habilitado só para{' '}
                                  <code className="font-mono">{repoId}</code>. Usa o token que você
                                  já salvou acima — sem login novo.
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="text-[10px] text-ink-400">
                  A escolha é obrigatória e não tem padrão. Sem ela o chat daquele repositório nem
                  fica sabendo que o {plataforma.label} existe — o que é melhor do que saber pela
                  metade: o token alcança a conta inteira, e um modelo que sabe do serviço mas não
                  do projeto sai listando todos e tentando até acertar, num turno pago para achar
                  o que você já sabia. Com o vínculo, o ref do projeto vai escrito no prompt.
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
