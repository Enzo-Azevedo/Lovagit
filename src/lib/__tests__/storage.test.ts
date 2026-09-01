import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Stub minimo de `chrome.storage.local` para exercitar o namespacing real. */
const store = new Map<string, unknown>();
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
      remove: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      },
    },
  },
});

const {
  addCheckpoint,
  disconnectRepo,
  getChat,
  getCheckpoints,
  getRepoMap,
  isValidRepoId,
  saveChat,
  saveRepoMap,
  saveSettings,
} = await import('../storage');

import type { ChatMessage, Checkpoint, RepoMap } from '../types';

function message(repoId: string, content: string): ChatMessage {
  return { id: content, repoId, role: 'user', content, createdAt: 0 };
}

function checkpoint(repoId: string, id: string): Checkpoint {
  return {
    id,
    repoId,
    backupBranch: 'lovagit/backup/main/x',
    baseSha: 'a',
    commitSha: 'b',
    branch: 'main',
    message: 'feat: algo',
    files: [],
    createdAt: 0,
  };
}

beforeEach(() => store.clear());

describe('isValidRepoId', () => {
  it('aceita owner/name e recusa o resto', () => {
    expect(isValidRepoId('acme/site')).toBe(true);
    expect(isValidRepoId('acme')).toBe(false);
    expect(isValidRepoId('acme/site/extra')).toBe(false);
    expect(isValidRepoId('../etc')).toBe(false);
  });
});

describe('chats isolados por repositorio', () => {
  it('grava em chaves separadas — um repo nao le o chat do outro', async () => {
    await saveChat('acme/site', [message('acme/site', 'do site')]);
    await saveChat('acme/api', [message('acme/api', 'da api')]);

    expect((await getChat('acme/site')).map((m) => m.content)).toEqual(['do site']);
    expect((await getChat('acme/api')).map((m) => m.content)).toEqual(['da api']);
  });

  it('recusa salvar mensagem de outro repositorio', async () => {
    await expect(saveChat('acme/site', [message('acme/api', 'intrusa')])).rejects.toThrow(
      /nao pode ser salva/,
    );
  });

  it('filtra mensagens contaminadas na leitura', async () => {
    store.set('repo:acme/site:chat', [message('acme/site', 'ok'), message('acme/api', 'intrusa')]);
    expect((await getChat('acme/site')).map((m) => m.content)).toEqual(['ok']);
  });

  it('rejeita repoId malformado antes de tocar no storage', async () => {
    await expect(getChat('..')).rejects.toThrow(/repoId invalido/);
  });
});

describe('mapas e checkpoints', () => {
  it('recusa mapa contaminado', async () => {
    store.set('repo:acme/site:map', { repoId: 'acme/api' } as RepoMap);
    await expect(getRepoMap('acme/site')).rejects.toThrow(/contaminado/);
  });

  it('mantem checkpoints separados por repositorio', async () => {
    await addCheckpoint(checkpoint('acme/site', 'cp1'));
    await addCheckpoint(checkpoint('acme/api', 'cp2'));
    expect((await getCheckpoints('acme/site')).map((c) => c.id)).toEqual(['cp1']);
    expect((await getCheckpoints('acme/api')).map((c) => c.id)).toEqual(['cp2']);
  });
});

describe('disconnectRepo', () => {
  it('apaga todo o estado do repositorio e preserva os demais', async () => {
    await saveSettings({ connectedRepoIds: ['acme/site', 'acme/api'] });
    await saveChat('acme/site', [message('acme/site', 'x')]);
    await saveRepoMap({ repoId: 'acme/site' } as RepoMap);
    await saveChat('acme/api', [message('acme/api', 'y')]);

    const settings = await disconnectRepo('acme/site');

    expect(settings.connectedRepoIds).toEqual(['acme/api']);
    expect(await getChat('acme/site')).toEqual([]);
    expect(await getRepoMap('acme/site')).toBeNull();
    expect((await getChat('acme/api')).map((m) => m.content)).toEqual(['y']);
  });
});

describe('isValidRepoId — casos de travessia', () => {
  it('recusa segmentos compostos so de pontos', () => {
    expect(isValidRepoId('../etc')).toBe(false);
    expect(isValidRepoId('acme/..')).toBe(false);
    expect(isValidRepoId('./x')).toBe(false);
  });

  it('aceita nomes legitimos que comecam com ponto', () => {
    expect(isValidRepoId('acme/.github')).toBe(true);
    expect(isValidRepoId('acme/next.js')).toBe(true);
  });
});
