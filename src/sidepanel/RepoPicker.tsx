import { useEffect, useMemo, useState } from 'react';
import { listRepositories, type RepoSummary } from '../lib/github/client';
import type { RepoId } from '../lib/types';
import { Button, ErrorNote, Spinner } from './ui';

interface RepoPickerProps {
  connectedIds: RepoId[];
  mappingRepoId: RepoId | null;
  mappingStep: string;
  onConnect: (repo: RepoSummary) => void;
  onDisconnect: (repoId: RepoId) => void;
  onClose: () => void;
}

export function RepoPicker({
  connectedIds,
  mappingRepoId,
  mappingStep,
  onConnect,
  onDisconnect,
  onClose,
}: RepoPickerProps) {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setRepos(await listRepositories());
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? repos.filter(
          (repo) =>
            repo.id.toLowerCase().includes(needle) ||
            (repo.description ?? '').toLowerCase().includes(needle),
        )
      : repos;
    return matches.slice(0, 100);
  }, [repos, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-ink-700 p-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filtrar repositorios..."
          className="flex-1 rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs outline-none placeholder:text-ink-600 focus:border-ink-600"
        />
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!repos && !error && <Spinner label="Carregando repositorios do GitHub..." />}

        {filtered.map((repo) => {
          const connected = connectedIds.includes(repo.id);
          const mapping = mappingRepoId === repo.id;
          return (
            <div
              key={repo.id}
              className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-ink-200">
                  {repo.id}
                  {repo.private && <span className="ml-1 text-[10px] text-ink-400">privado</span>}
                  {repo.archived && <span className="ml-1 text-[10px] text-amber-400">arquivado</span>}
                </p>
                <p className="truncate text-[10px] text-ink-400">
                  {mapping ? mappingStep : (repo.description ?? repo.defaultBranch)}
                </p>
              </div>
              {mapping ? (
                <Spinner />
              ) : connected ? (
                <Button variant="ghost" onClick={() => onDisconnect(repo.id)}>
                  Desconectar
                </Button>
              ) : (
                <Button onClick={() => onConnect(repo)}>Conectar</Button>
              )}
            </div>
          );
        })}

        {repos && filtered.length === 0 && (
          <p className="p-4 text-center text-xs text-ink-400">Nenhum repositorio encontrado.</p>
        )}
      </div>
    </div>
  );
}
