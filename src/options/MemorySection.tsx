import { useCallback, useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../lib/storage';
import {
  BUDGET_SEM_PERMISSAO_BYTES,
  DEFAULT_MEMORY_BUDGET_BYTES,
  MIN_MEMORY_BUDGET_BYTES,
  hasUnlimitedStorage,
  memoryUsage,
  requestUnlimitedStorage,
} from '../lib/memory/store';
import type { MemoryUsage } from '../lib/memory/types';

const MB = 1024 * 1024;

function formatarBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}

export function MemorySection() {
  const [usage, setUsage] = useState<MemoryUsage | null>(null);
  const [ilimitado, setIlimitado] = useState(false);
  const [budgetMb, setBudgetMb] = useState(String(DEFAULT_MEMORY_BUDGET_BYTES / MB));

  const recarregar = useCallback(async () => {
    const [uso, permissao, settings] = await Promise.all([
      memoryUsage(),
      hasUnlimitedStorage(),
      getSettings(),
    ]);
    setUsage(uso);
    setIlimitado(permissao);
    setBudgetMb(String(Math.round(settings.memoryBudgetBytes / MB)));
  }, []);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  const salvarBudget = useCallback(async () => {
    const mb = Number(budgetMb);
    if (!Number.isFinite(mb) || mb <= 0) return;
    const bytes = Math.max(MIN_MEMORY_BUDGET_BYTES, Math.round(mb * MB));
    await saveSettings({ memoryBudgetBytes: bytes });
    await recarregar();
  }, [budgetMb, recarregar]);

  const pedirPermissao = useCallback(async () => {
    await requestUnlimitedStorage();
    await recarregar();
  }, [recarregar]);

  return (
    <section className="space-y-3 rounded-lg border border-ink-700 bg-ink-900 p-4">
      <h2 className="text-sm text-ink-200">5. Memoria dos repositorios</h2>
      <p className="text-xs text-ink-400">
        A IA guarda o que voce pediu e o que foi aplicado, e leva um recorte disso para as
        proximas conversas. O teto abaixo vale para o conjunto de todos os repositorios: um
        projeto sozinho pode ocupar quase tudo, e a compressao so entra quando o total passa do
        limite — comprimindo primeiro o mais antigo, de qualquer repositorio.
      </p>

      {usage && (
        <div className="space-y-1 rounded-md border border-ink-700 p-2 text-xs text-ink-200">
          <p>
            Em uso: {formatarBytes(usage.bytes)} de {formatarBytes(usage.budgetBytes)} ·{' '}
            {usage.entries} entrada(s)
          </p>
          {usage.byRepo
            .filter((repo) => repo.entries > 0)
            .map((repo) => (
              <p key={repo.repoId} className="font-mono text-[10px] text-ink-400">
                {repo.repoId}: {formatarBytes(repo.bytes)} · {repo.entries} entrada(s)
              </p>
            ))}
          {usage.entries === 0 && (
            <p className="text-[10px] text-ink-400">
              Nada guardado ainda. A memoria comeca a encher quando um pedido seu vira alteracao
              no repositorio.
            </p>
          )}
        </div>
      )}

      <label className="block text-xs text-ink-200">
        Teto total (MB)
        <span className="mt-1 flex gap-2">
          <input
            type="number"
            min={1}
            className="w-32 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-100"
            value={budgetMb}
            onChange={(event) => setBudgetMb(event.target.value)}
          />
          <button
            type="button"
            className="rounded-md border border-ink-700 px-2.5 py-1 text-xs text-ink-200 hover:bg-ink-800"
            onClick={() => void salvarBudget()}
          >
            Salvar
          </button>
        </span>
      </label>

      {ilimitado ? (
        <p className="text-[11px] text-emerald-400">
          Armazenamento ilimitado concedido — o teto acima vale como voce configurou.
        </p>
      ) : (
        <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
          <p className="text-[11px] text-amber-300">
            Sem a permissao de armazenamento ilimitado, o Chrome da{' '}
            {formatarBytes(10 * MB)} para TUDO que a extensao guarda — mapa, conversas,
            historico. A memoria fica limitada a {formatarBytes(BUDGET_SEM_PERMISSAO_BYTES)}{' '}
            para o resto continuar cabendo, independente do teto configurado acima.
          </p>
          <button
            type="button"
            className="rounded-md border border-amber-500/40 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-500/10"
            onClick={() => void pedirPermissao()}
          >
            Permitir armazenamento ilimitado
          </button>
        </div>
      )}
    </section>
  );
}
