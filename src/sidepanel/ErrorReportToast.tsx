import { useEffect, useMemo, useState } from 'react';
import {
  cancelPendingReport,
  previewPendingReport,
  sendPendingNow,
  subscribeTelemetry,
  type LogEntry,
  type PendingView,
} from '../lib/telemetry/reporter';
import { Button } from './ui';

/**
 * Janela de desfazer. O relatorio vai para um repositorio publico, entao a
 * extensao mostra exatamente o que sera publicado e deixa cancelar antes.
 */
export function ErrorReportToast() {
  const [pending, setPending] = useState<PendingView[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [now, setNow] = useState(Date.now());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dismissedLogId, setDismissedLogId] = useState<string | null>(null);

  useEffect(() => subscribeTelemetry((snapshot) => {
    setPending(snapshot.pending);
    setLog(snapshot.log);
  }), []);

  useEffect(() => {
    if (pending.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [pending.length]);

  const preview = useMemo(() => (previewId ? previewPendingReport(previewId) : null), [previewId]);

  const lastSent = log.find(
    (entry) => (entry.status === 'reportado' || entry.status === 'agrupado') && entry.issueUrl,
  );
  const showSent = lastSent && lastSent.id !== dismissedLogId && Date.now() - lastSent.createdAt < 120_000;

  if (pending.length === 0 && !showSent) return null;

  return (
    <div className="space-y-1 border-t border-ink-700 bg-ink-900 p-2">
      {pending.map((item) => {
        const secondsLeft = Math.max(0, Math.ceil((item.sendAt - now) / 1000));
        return (
          <div
            key={item.id}
            className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px]"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-amber-300">
                  Erro detectado — reportando em {secondsLeft}s
                  {item.highPriority && (
                    <span className="ml-1 rounded bg-red-500/20 px-1 text-red-300">
                      Alta Prioridade
                    </span>
                  )}
                </p>
                <p className="truncate font-mono text-[10px] text-ink-400">{item.title}</p>
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Button variant="ghost" onClick={() => cancelPendingReport(item.id)}>
                Cancelar envio
              </Button>
              <Button variant="ghost" onClick={() => setPreviewId(item.id)}>
                Ver o que sera enviado
              </Button>
              <Button variant="ghost" onClick={() => sendPendingNow(item.id)}>
                Enviar agora
              </Button>
            </div>
          </div>
        );
      })}

      {showSent && lastSent && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-[11px]">
          <span className="min-w-0 truncate text-ink-400">
            {lastSent.status === 'agrupado' ? 'Agrupado no issue' : 'Issue aberto'}{' '}
            <a
              className="text-lime-accent hover:underline"
              href={lastSent.issueUrl}
              target="_blank"
              rel="noreferrer"
            >
              #{lastSent.issueNumber}
            </a>
          </span>
          <Button variant="ghost" onClick={() => setDismissedLogId(lastSent.id)}>
            OK
          </Button>
        </div>
      )}

      {preview && (
        <div className="rounded-md border border-ink-700 bg-ink-950 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] text-ink-200">Conteudo do relatorio</span>
            <Button variant="ghost" onClick={() => setPreviewId(null)}>
              Fechar
            </Button>
          </div>
          <p className="mb-1 font-mono text-[10px] text-ink-200">{preview.title}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-ink-400">
            {preview.body}
          </pre>
        </div>
      )}
    </div>
  );
}
