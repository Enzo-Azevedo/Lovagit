import { useCallback, useEffect, useState } from 'react';
import { isValidRepoId } from '../lib/storage';
import {
  getReportLog,
  getTelemetrySettings,
  saveTelemetrySettings,
  type LogEntry,
} from '../lib/telemetry/reporter';
import { LABELS, type TelemetrySettings } from '../lib/telemetry/types';

const inputClass =
  'w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ink-200 outline-none placeholder:text-ink-600 focus:border-ink-600';

const STATUS_STYLE: Record<LogEntry['status'], string> = {
  pendente: 'text-amber-300',
  reportado: 'text-lime-accent',
  agrupado: 'text-ink-400',
  cancelado: 'text-ink-400',
  suprimido: 'text-ink-400',
  ignorado: 'text-ink-400',
  falhou: 'text-red-300',
};

export function TelemetrySection() {
  const [settings, setSettings] = useState<TelemetrySettings | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [repoDraft, setRepoDraft] = useState('');

  const reload = useCallback(async () => {
    const loaded = await getTelemetrySettings();
    setSettings(loaded);
    setRepoDraft(loaded.targetRepoId);
    setLog(await getReportLog());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback(
    async (patch: Partial<TelemetrySettings>) => {
      setSettings(await saveTelemetrySettings(patch));
    },
    [],
  );

  if (!settings) return null;
  const repoDraftValid = isValidRepoId(repoDraft.trim());

  return (
    <section className="space-y-3 rounded-lg border border-ink-700 bg-ink-900 p-4">
      <h2 className="text-sm text-ink-200">4. Deteccao e relato de erros</h2>

      <label className="flex items-start gap-2 text-xs text-ink-200">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={settings.enabled}
          onChange={(event) => void update({ enabled: event.target.checked })}
        />
        <span>
          Abrir issue automaticamente quando um defeito for detectado
          <span className="mt-1 block text-[11px] text-ink-400">
            Só defeito vira issue. Erro de configuracao (chave errada, token sem permissao) e
            falha passageira (offline, rate limit) ficam apenas na interface. Erros da propria
            extensao entram com as labels <code>{LABELS.highPriority}</code> e{' '}
            <code>{LABELS.extensionError}</code>; falhas de servico externo entram com{' '}
            <code>{LABELS.integrationError}</code>.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-3 gap-3">
        <label className="col-span-3 block space-y-1">
          <span className="block text-xs text-ink-200">Repositorio de destino</span>
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={repoDraft}
              onChange={(event) => setRepoDraft(event.target.value)}
              placeholder="owner/nome"
            />
            <button
              className="rounded-md bg-lime-accent px-3 py-1.5 text-xs font-medium text-ink-950 disabled:opacity-40"
              disabled={!repoDraftValid || repoDraft.trim() === settings.targetRepoId}
              onClick={() => void update({ targetRepoId: repoDraft.trim() })}
            >
              Salvar
            </button>
          </div>
          <span className="block text-[11px] text-ink-400">
            O PAT precisa de <code>Issues: Read and write</code> neste repositorio. Sem push access,
            o GitHub descarta as labels em silencio — por isso a prioridade tambem vai escrita no
            corpo do issue.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="block text-xs text-ink-200">Janela para cancelar (s)</span>
          <input
            type="number"
            min={0}
            max={120}
            className={inputClass}
            value={settings.undoSeconds}
            onChange={(event) => void update({ undoSeconds: Number(event.target.value) })}
          />
        </label>

        <label className="block space-y-1">
          <span className="block text-xs text-ink-200">Issues novos por hora</span>
          <input
            type="number"
            min={1}
            max={50}
            className={inputClass}
            value={settings.maxIssuesPerHour}
            onChange={(event) => void update({ maxIssuesPerHour: Number(event.target.value) })}
          />
        </label>
      </div>

      <details className="rounded-md border border-ink-700 bg-ink-950">
        <summary className="cursor-pointer px-3 py-2 text-xs text-ink-400">
          Historico local de relatorios ({log.length})
        </summary>
        <div className="space-y-1 border-t border-ink-700 p-2">
          {log.length === 0 && <p className="text-[11px] text-ink-400">Nenhum erro registrado.</p>}
          {log.map((entry) => (
            <div key={entry.id} className="rounded border border-ink-700 p-2">
              <p className="flex items-center gap-2 text-[11px]">
                <span className={STATUS_STYLE[entry.status]}>{entry.status}</span>
                <span className="text-ink-400">
                  {new Date(entry.createdAt).toLocaleString('pt-BR')}
                </span>
                {entry.issueUrl && (
                  <a
                    className="text-lime-accent hover:underline"
                    href={entry.issueUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    #{entry.issueNumber}
                  </a>
                )}
              </p>
              <p className="truncate font-mono text-[10px] text-ink-200">{entry.title}</p>
              <p className="text-[10px] text-ink-400">{entry.detail}</p>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
