import { useState } from 'react';
import { collapseContext, diffLines, diffStats } from '../lib/diff';
import type { PendingFileChange } from '../lib/types';

const ACTION_LABEL: Record<PendingFileChange['action'], string> = {
  create: 'novo',
  update: 'alterado',
  delete: 'removido',
};

export function DiffView({ change }: { change: PendingFileChange }) {
  const [open, setOpen] = useState(false);
  const lines = diffLines(change.previousContent ?? '', change.content ?? '');
  const stats = diffStats(lines);
  const visible = open ? collapseContext(lines, 3) : [];

  return (
    <div className="rounded-md border border-ink-700 bg-ink-950">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left font-mono text-[11px] hover:bg-ink-800"
      >
        <span className="text-ink-400">{open ? '▾' : '▸'}</span>
        <span className="flex-1 truncate text-ink-200">{change.path}</span>
        <span className="text-ink-400">{ACTION_LABEL[change.action]}</span>
        <span className="text-emerald-400">+{stats.added}</span>
        <span className="text-red-400">-{stats.removed}</span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto border-t border-ink-700 p-2 font-mono text-[11px] leading-snug">
          {visible.map((line, index) => (
            <div
              key={index}
              className={
                line.type === 'add'
                  ? 'bg-emerald-500/10 text-emerald-300'
                  : line.type === 'del'
                    ? 'bg-red-500/10 text-red-300'
                    : line.type === 'gap'
                      ? 'text-ink-600 italic'
                      : 'text-ink-400'
              }
            >
              {line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'gap' ? ' ' : ' '}
              {line.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
