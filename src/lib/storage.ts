import type {
  ChatMessage,
  Checkpoint,
  PendingFileChange,
  RepoId,
  RepoMap,
  RepoRef,
  Settings,
} from './types';

/**
 * Toda leitura/escrita de dados de repositorio passa por aqui e **exige** um
 * repoId. As chaves sao namespaced por repositorio (`repo:<owner/name>:...`),
 * o que garante que uma conversa nunca leia o estado de outro repositorio.
 */

const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function isValidRepoId(repoId: string): boolean {
  const segments = repoId.split('/');
  if (segments.length !== 2) return false;
  // Um segmento so de pontos ("." ou "..") viraria travessia de caminho na URL
  // da API do GitHub — `/repos/../algo` sai do escopo pretendido.
  return segments.every(
    (segment) => REPO_SEGMENT_RE.test(segment) && !/^\.+$/.test(segment),
  );
}

export function assertRepoId(repoId: string): RepoId {
  if (!isValidRepoId(repoId)) {
    throw new Error(`repoId invalido: ${JSON.stringify(repoId)} (esperado "owner/name")`);
  }
  return repoId;
}

const keys = {
  settings: 'settings',
  repoRef: (id: RepoId) => `repo:${assertRepoId(id)}:ref`,
  repoMap: (id: RepoId) => `repo:${assertRepoId(id)}:map`,
  chat: (id: RepoId) => `repo:${assertRepoId(id)}:chat`,
  checkpoints: (id: RepoId) => `repo:${assertRepoId(id)}:checkpoints`,
  pending: (id: RepoId) => `repo:${assertRepoId(id)}:pending`,
};

export const DEFAULT_SETTINGS: Settings = {
  providers: [],
  activeProviderId: null,
  connectedRepoIds: [],
  autoApplyChanges: true,
  autoRetryOnFailure: false,
  githubUser: null,
};

async function readKey<T>(key: string, fallback: T): Promise<T> {
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as T | undefined) ?? fallback;
}

export async function getSettings(): Promise<Settings> {
  const stored = await readKey<Partial<Settings>>(keys.settings, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [keys.settings]: next });
  return next;
}

export async function getRepoRef(repoId: RepoId): Promise<RepoRef | null> {
  return readKey<RepoRef | null>(keys.repoRef(repoId), null);
}

export async function saveRepoRef(ref: RepoRef): Promise<void> {
  await chrome.storage.local.set({ [keys.repoRef(ref.id)]: ref });
}

export async function getRepoMap(repoId: RepoId): Promise<RepoMap | null> {
  const map = await readKey<RepoMap | null>(keys.repoMap(repoId), null);
  if (map && map.repoId !== repoId) {
    // Nunca deveria acontecer; se acontecer, e' contaminacao de contexto.
    throw new Error(`Mapa contaminado: esperado ${repoId}, encontrado ${map.repoId}`);
  }
  return map;
}

export async function saveRepoMap(map: RepoMap): Promise<void> {
  await chrome.storage.local.set({ [keys.repoMap(map.repoId)]: map });
}

export async function getChat(repoId: RepoId): Promise<ChatMessage[]> {
  const messages = await readKey<ChatMessage[]>(keys.chat(repoId), []);
  return messages.filter((m) => m.repoId === repoId);
}

export async function saveChat(repoId: RepoId, messages: ChatMessage[]): Promise<void> {
  const foreign = messages.find((m) => m.repoId !== repoId);
  if (foreign) {
    throw new Error(`Mensagem de ${foreign.repoId} nao pode ser salva no chat de ${repoId}`);
  }
  await chrome.storage.local.set({ [keys.chat(repoId)]: messages });
}

export async function getCheckpoints(repoId: RepoId): Promise<Checkpoint[]> {
  const list = await readKey<Checkpoint[]>(keys.checkpoints(repoId), []);
  return list.filter((c) => c.repoId === repoId);
}

export async function addCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint[]> {
  const list = await getCheckpoints(checkpoint.repoId);
  const next = [checkpoint, ...list].slice(0, 100);
  await chrome.storage.local.set({ [keys.checkpoints(checkpoint.repoId)]: next });
  return next;
}

export async function updateCheckpoint(
  repoId: RepoId,
  checkpointId: string,
  patch: Partial<Checkpoint>,
): Promise<Checkpoint[]> {
  const list = await getCheckpoints(repoId);
  const next = list.map((c) => (c.id === checkpointId ? { ...c, ...patch } : c));
  await chrome.storage.local.set({ [keys.checkpoints(repoId)]: next });
  return next;
}

export interface PendingChangeSet {
  repoId: RepoId;
  changes: PendingFileChange[];
  message: string;
  createdAt: number;
}

export async function getPendingChanges(repoId: RepoId): Promise<PendingChangeSet | null> {
  const pending = await readKey<PendingChangeSet | null>(keys.pending(repoId), null);
  return pending && pending.repoId === repoId ? pending : null;
}

export async function savePendingChanges(pending: PendingChangeSet): Promise<void> {
  await chrome.storage.local.set({ [keys.pending(pending.repoId)]: pending });
}

export async function clearPendingChanges(repoId: RepoId): Promise<void> {
  await chrome.storage.local.remove(keys.pending(repoId));
}

/** Remove o repositorio da lista conectada e apaga TODO o estado dele. */
export async function disconnectRepo(repoId: RepoId): Promise<Settings> {
  await chrome.storage.local.remove([
    keys.repoRef(repoId),
    keys.repoMap(repoId),
    keys.chat(repoId),
    keys.checkpoints(repoId),
    keys.pending(repoId),
  ]);
  const settings = await getSettings();
  return saveSettings({
    connectedRepoIds: settings.connectedRepoIds.filter((id) => id !== repoId),
  });
}
