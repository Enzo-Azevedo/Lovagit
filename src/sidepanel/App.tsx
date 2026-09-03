import { useCallback, useEffect, useState } from 'react';
import { hasUnlimitedStorage, requestUnlimitedStorage } from '../lib/memory/store';
import { saveSettings } from '../lib/storage';
import { installErrorHandlers } from '../lib/telemetry/reporter';
import { ChatView } from './ChatView';
import { ErrorReportToast } from './ErrorReportToast';
import { RepoPicker } from './RepoPicker';
import { UpdateBar } from './UpdateBar';
import { useCursorGlow } from './useCursorGlow';
import { useRepos } from './useRepos';
import { Button, ErrorNote, Spinner } from './ui';

/** Banner de primeira abertura pedindo `unlimitedStorage`. Some para sempre
 *  depois da primeira resposta — concedida ou nao — porque pedir permissao
 *  exige gesto do usuario e reabrir a pergunta a cada painel seria spam. */
function UnlimitedStorageBanner({ onDone }: { onDone: () => void }) {
  const [pending, setPending] = useState(false);

  const responder = useCallback(
    async (pedir: boolean) => {
      setPending(true);
      if (pedir) await requestUnlimitedStorage();
      await saveSettings({ unlimitedStorageAsked: true });
      setPending(false);
      onDone();
    },
    [onDone],
  );

  return (
    <div className="space-y-2 border-b border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-[11px] text-amber-300">
        Sem armazenamento ilimitado, o Chrome da 10 MB para TUDO que a extensao guarda — mapa,
        conversas, historico. Nessa cota, a memoria dos repositorios fica limitada a 4 MB para
        o resto continuar cabendo. Permite o armazenamento ilimitado?
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          className="rounded-md border border-amber-500/40 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-500/10 disabled:opacity-50"
          onClick={() => void responder(true)}
        >
          Permitir
        </button>
        <button
          type="button"
          disabled={pending}
          className="rounded-md px-2.5 py-1 text-xs text-ink-400 hover:text-ink-200 disabled:opacity-50"
          onClick={() => void responder(false)}
        >
          Agora nao
        </button>
      </div>
      <p className="text-[10px] text-ink-400">
        Da para mudar depois nas configuracoes, secao de memoria.
      </p>
    </div>
  );
}

export function App() {
  const { state, connect, remap, disconnect, syncGitHubUser } = useRepos();
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /** Esconde o banner assim que respondido, sem esperar o refresh do storage. */
  const [storageBannerDismissed, setStorageBannerDismissed] = useState(false);
  const [unlimitedGranted, setUnlimitedGranted] = useState(true);

  useCursorGlow();

  // Pega o que escapou de todo try/catch da aplicacao.
  useEffect(() => installErrorHandlers('sidepanel'), []);

  useEffect(() => {
    if (state.hasToken && !state.settings.githubUser) void syncGitHubUser();
  }, [state.hasToken, state.settings.githubUser, syncGitHubUser]);

  useEffect(() => {
    void hasUnlimitedStorage().then(setUnlimitedGranted);
  }, []);

  useEffect(() => {
    if (activeRepoId && state.repos.some((repo) => repo.id === activeRepoId)) return;
    setActiveRepoId(state.repos[0]?.id ?? null);
  }, [activeRepoId, state.repos]);

  const activeRepo = state.repos.find((repo) => repo.id === activeRepoId) ?? null;
  const openOptions = () => chrome.runtime.openOptionsPage();
  const showStorageBanner =
    !unlimitedGranted && !storageBannerDismissed && !state.settings.unlimitedStorageAsked;

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
      <header className="glass flex items-center gap-2 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
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

      <UpdateBar />

      {showStorageBanner && (
        <UnlimitedStorageBanner onDone={() => setStorageBannerDismissed(true)} />
      )}

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
