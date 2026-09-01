import { useCallback, useEffect, useState } from 'react';
import { getAuthenticatedUser, type RepoSummary } from '../lib/github/client';
import { buildRepoMap } from '../lib/github/mapper';
import {
  disconnectRepo,
  getRepoRef,
  getSettings,
  saveRepoMap,
  saveRepoRef,
  saveSettings,
} from '../lib/storage';
import { captureError } from '../lib/telemetry/reporter';
import type { RepoId, RepoRef, Settings } from '../lib/types';
import { hasSecret, SecretNames } from '../lib/vault';

export interface ReposState {
  loading: boolean;
  settings: Settings;
  repos: RepoRef[];
  hasToken: boolean;
  mappingRepoId: RepoId | null;
  mappingStep: string;
  error: string | null;
}

export function useRepos() {
  const [state, setState] = useState<ReposState>({
    loading: true,
    settings: {
      providers: [],
      activeProviderId: null,
      connectedRepoIds: [],
      autoApplyChanges: true,
      githubUser: null,
    },
    repos: [],
    hasToken: false,
    mappingRepoId: null,
    mappingStep: '',
    error: null,
  });

  const refresh = useCallback(async () => {
    const settings = await getSettings();
    const hasToken = await hasSecret(SecretNames.githubPat);
    const refs = await Promise.all(settings.connectedRepoIds.map((id) => getRepoRef(id)));
    setState((prev) => ({
      ...prev,
      loading: false,
      settings,
      hasToken,
      repos: refs.filter((ref): ref is RepoRef => ref !== null),
    }));
  }, []);

  useEffect(() => {
    void refresh();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && ('settings' in changes || Object.keys(changes).some((k) => k.startsWith('secret:')))) {
        void refresh();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refresh]);

  /** Conecta e mapeia. O mapeamento e' o que impede a IA de se perder depois. */
  const connect = useCallback(
    async (summary: RepoSummary) => {
      const ref: RepoRef = {
        id: summary.id,
        owner: summary.owner,
        name: summary.name,
        defaultBranch: summary.defaultBranch,
        private: summary.private,
        htmlUrl: summary.htmlUrl,
      };
      setState((prev) => ({ ...prev, mappingRepoId: ref.id, mappingStep: 'Conectando...', error: null }));
      try {
        await saveRepoRef(ref);
        const map = await buildRepoMap(ref, (step) =>
          setState((prev) => ({ ...prev, mappingStep: step })),
        );
        await saveRepoMap(map);
        const settings = await getSettings();
        if (!settings.connectedRepoIds.includes(ref.id)) {
          await saveSettings({ connectedRepoIds: [...settings.connectedRepoIds, ref.id] });
        }
        await refresh();
        return ref;
      } catch (error) {
        setState((prev) => ({
          ...prev,
          error: error instanceof Error ? error.message : String(error),
        }));
        void captureError(error, {
          module: 'sidepanel/useRepos',
          repoId: ref.id,
          step: 'mapeamento',
        });
        return null;
      } finally {
        setState((prev) => ({ ...prev, mappingRepoId: null, mappingStep: '' }));
      }
    },
    [refresh],
  );

  /** Refaz o mapa (apos commits externos, ou quando o repo mudou muito). */
  const remap = useCallback(
    async (repoId: RepoId) => {
      const ref = await getRepoRef(repoId);
      if (!ref) return;
      setState((prev) => ({ ...prev, mappingRepoId: repoId, mappingStep: 'Remapeando...' }));
      try {
        const map = await buildRepoMap(ref, (step) => setState((prev) => ({ ...prev, mappingStep: step })));
        await saveRepoMap(map);
      } catch (error) {
        setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : String(error) }));
        void captureError(error, {
          module: 'sidepanel/useRepos',
          repoId,
          step: 'remapeamento',
        });
      } finally {
        setState((prev) => ({ ...prev, mappingRepoId: null, mappingStep: '' }));
        await refresh();
      }
    },
    [refresh],
  );

  const disconnect = useCallback(
    async (repoId: RepoId) => {
      await disconnectRepo(repoId);
      await refresh();
    },
    [refresh],
  );

  const syncGitHubUser = useCallback(async () => {
    try {
      const user = await getAuthenticatedUser();
      await saveSettings({ githubUser: { login: user.login, avatarUrl: user.avatarUrl } });
      await refresh();
    } catch {
      // Sem token valido: a UI ja cobre esse estado.
    }
  }, [refresh]);

  return { state, refresh, connect, remap, disconnect, syncGitHubUser };
}
