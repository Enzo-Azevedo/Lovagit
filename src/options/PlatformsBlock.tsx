import { useCallback, useEffect, useState } from 'react';
import { requestHostPermission } from '../lib/mcp/permissions';
import { checkSupabaseToken } from '../lib/platforms/supabase';
import {
  getPlatformConnections,
  getPlatformToken,
  setPlatformToken,
  updatePlatformConnection,
} from '../lib/platforms/store';
import { PLATFORMS, type PlatformConnection, type PlatformId } from '../lib/platforms/types';

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

  const reload = useCallback(async () => {
    const lista = await getPlatformConnections();
    setConexoes(lista);
    const tokens = await Promise.all(
      lista.map(async (conexao) => [conexao.id, (await getPlatformToken(conexao.id)) ?? ''] as const),
    );
    setDrafts(Object.fromEntries(tokens));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const salvar = useCallback(
    async (id: PlatformId) => {
      const plataforma = PLATFORMS.find((item) => item.id === id);
      const token = (drafts[id] ?? '').trim();

      // Primeiro await do clique: `permissions.request` exige o gesto do
      // usuario, e qualquer await antes dele ja encerra o gesto.
      if (token && plataforma && !(await requestHostPermission(plataforma.apiOrigin))) {
        onMessage(
          `Sem permissao para ${plataforma.apiOrigin} — o token nao tem como ser verificado nem usado.`,
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
                Um token do {plataforma.label} comeca com <code>{plataforma.tokenPrefix}</code> — o
                que esta ai parece ser outra credencial.
              </p>
            )}

            {conexao?.lastError && <p className="text-[10px] text-red-300">{conexao.lastError}</p>}
            {conexao?.lastCheck && !conexao.lastError && (
              <p className="text-[10px] text-ink-400">{conexao.lastCheck}</p>
            )}

            <p className="text-[10px] text-ink-400">
              {plataforma.scopeWarning} Fica no cofre cifrado, e serve tambem para o servidor MCP do
              proprio {plataforma.label} — sem precisar cadastrar duas vezes.
            </p>
          </div>
        );
      })}
    </div>
  );
}
