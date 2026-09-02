import { useEffect, useState } from 'react';
import { installErrorHandlers } from '../lib/telemetry/reporter';
import { ChatView } from './ChatView';
import { ErrorReportToast } from './ErrorReportToast';
import { RepoPicker } from './RepoPicker';
import { useRepos } from './useRepos';
import { Button, ErrorNote, Spinner } from './ui';

export function App() {
  const { state, connect, remap, disconnect, syncGitHubUser } = useRepos();
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  // Pega o que escapou de todo try/catch da aplicacao.
  useEffect(() => installErrorHandlers('sidepanel'), []);

  useEffect(() => {
    if (state.hasToken && !state.settings.githubUser) void syncGitHubUser();
  }, [state.hasToken, state.settings.githubUser, syncGitHubUser]);

  useEffect(() => {
    if (activeRepoId && state.repos.some((repo) => repo.id === activeRepoId)) return;
    setActiveRepoId(state.repos[0]?.id ?? null);
  }, [activeRepoId, state.repos]);

  const activeRepo = state.repos.find((repo) => repo.id === activeRepoId) ?? null;
  const openOptions = () => chrome.runtime.openOptionsPage();

  if (state.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Carregando..." />
      </div>
    );
  }

  if (!state.hasToken) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-sm font-medium text-ink-200">Lovagit</h1>
        <p className="text-xs text-ink-400">
          Conecte um token PAT do GitHub para listar seus repositorios. Cada repositorio vira um
          chat isolado com a IA.
        </p>
        <Button variant="primary" onClick={openOptions}>
          Abrir configuracoes
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <select
          value={activeRepoId ?? ''}
          onChange={(event) => setActiveRepoId(event.target.value || null)}
          className="min-w-0 flex-1 truncate rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ink-200 outline-none"
        >
          {state.repos.length === 0 && <option value="">Nenhum repositorio conectado</option>}
          {state.repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.id}
            </option>
          ))}
        </select>
        <Button variant="ghost" onClick={() => setPicking((value) => !value)} title="Repositorios">
          {picking ? 'Voltar' : 'Repos'}
        </Button>
        {activeRepo && !picking && (
          <Button
            variant="ghost"
            title="Refaz o mapeamento do repositorio"
            disabled={state.mappingRepoId !== null}
            onClick={() => void remap(activeRepo.id)}
          >
            {state.mappingRepoId === activeRepo.id ? '...' : 'Remapear'}
          </Button>
        )}
        <Button variant="ghost" onClick={openOptions} title="Configuracoes">
          ⚙
        </Button>
      </header>

      {state.error && (
        <div className="p-2">
          <ErrorNote>{state.error}</ErrorNote>
        </div>
      )}

      {picking ? (
        <RepoPicker
          connectedIds={state.settings.connectedRepoIds}
          mappingRepoId={state.mappingRepoId}
          mappingStep={state.mappingStep}
          onConnect={(repo) => {
            void connect(repo).then((connected) => {
              if (connected) {
                setActiveRepoId(connected.id);
                setPicking(false);
              }
            });
          }}
          onDisconnect={(repoId) => void disconnect(repoId)}
          onClose={() => setPicking(false)}
        />
      ) : activeRepo ? (
        <ChatView
          key={activeRepo.id}
          repo={activeRepo}
          settings={state.settings}
          onRequestSettings={openOptions}
          onRemap={() => void remap(activeRepo.id)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-xs text-ink-400">
            Nenhum repositorio conectado ainda. Cada um que voce conectar vira um chat proprio,
            com contexto separado.
          </p>
          <Button variant="primary" onClick={() => setPicking(true)}>
            Escolher repositorios
          </Button>
        </div>
      )}

      <ErrorReportToast />
    </div>
  );
}
