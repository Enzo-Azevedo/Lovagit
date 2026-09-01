/**
 * Cofre de segredos (PAT do GitHub, chaves de API, tokens OAuth).
 *
 * Os segredos nunca ficam em texto puro em `chrome.storage.local`: sao cifrados
 * com AES-GCM usando uma chave mestra **nao exportavel** guardada no IndexedDB
 * da propria extensao. Assim, um dump do storage (ou uma extensao de
 * inspecao de storage) nao entrega o PAT, e a chave nao pode ser copiada para
 * fora do navegador nem por codigo nosso.
 */

const DB_NAME = 'lovagit-vault';
const DB_STORE = 'keys';
const MASTER_KEY_ID = 'master-v1';
const SECRET_PREFIX = 'secret:';

export const SecretNames = {
  githubPat: 'github_pat',
  providerApiKey: (providerId: string) => `provider:${providerId}:api_key`,
  providerOAuth: (providerId: string) => `provider:${providerId}:oauth`,
  mcpOAuth: (serverId: string) => `mcp:${serverId}:oauth`,
} as const;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) {
        req.result.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let masterKeyPromise: Promise<CryptoKey> | null = null;

async function getMasterKey(): Promise<CryptoKey> {
  if (!masterKeyPromise) {
    masterKeyPromise = (async () => {
      const db = await openDb();
      const existing = await idbGet<CryptoKey>(db, MASTER_KEY_ID);
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      await idbPut(db, MASTER_KEY_ID, key);
      return key;
    })().catch((err) => {
      masterKeyPromise = null;
      throw err;
    });
  }
  return masterKeyPromise;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function setSecret(name: string, value: string): Promise<void> {
  const key = await getMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(value),
  );
  await chrome.storage.local.set({
    [SECRET_PREFIX + name]: { iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) },
  });
}

export async function getSecret(name: string): Promise<string | null> {
  const stored = await chrome.storage.local.get(SECRET_PREFIX + name);
  const record = stored[SECRET_PREFIX + name] as { iv: string; data: string } | undefined;
  if (!record) return null;
  try {
    const key = await getMasterKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) },
      key,
      fromBase64(record.data),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Chave mestra perdida (perfil recriado): trata como ausente em vez de quebrar.
    return null;
  }
}

export async function deleteSecret(name: string): Promise<void> {
  await chrome.storage.local.remove(SECRET_PREFIX + name);
}

export async function hasSecret(name: string): Promise<boolean> {
  const stored = await chrome.storage.local.get(SECRET_PREFIX + name);
  return Boolean(stored[SECRET_PREFIX + name]);
}
