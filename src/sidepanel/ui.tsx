import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  const styles: Record<string, string> = {
    default: 'bg-ink-700 hover:bg-ink-600 text-ink-200 border border-ink-600',
    primary: 'bg-lime-accent hover:bg-lime-300 text-ink-950 font-medium border border-transparent',
    danger: 'bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30',
    ghost: 'bg-transparent hover:bg-ink-800 text-ink-400 hover:text-ink-200 border border-transparent',
  };
  return (
    <button
      {...props}
      className={`rounded-md px-2.5 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    />
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-ink-400">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-600 border-t-lime-accent" />
      {label}
    </span>
  );
}

export function Panel({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-ink-700 bg-ink-900">
      <header className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
        <h2 className="text-xs font-medium text-ink-200">{title}</h2>
        {actions}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
      {children}
    </p>
  );
}

/** Render minimo de markdown: paragrafos + blocos de codigo com ```. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <pre
            key={index}
            className="overflow-x-auto rounded-md border border-ink-700 bg-ink-950 p-2 font-mono text-[11px] text-ink-200"
          >
            <code>{part.replace(/^[\w+-]*\n/, '')}</code>
          </pre>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </div>
  );
}
