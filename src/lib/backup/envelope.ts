/**
 * Envelope cifrado do backup.
 *
 * O arquivo de backup carrega o PAT do GitHub, as chaves de API e os tokens dos
 * servidores MCP. Ele nasce para ficar parado numa pasta de Downloads ate a
 * proxima instalacao — talvez por semanas —, e nesse tempo qualquer coisa com
 * acesso ao disco poderia le-lo. Por isso ele sai cifrado com uma senha, e nao
 * em texto puro.
 *
 * A senha nao vira chave diretamente: passa por PBKDF2 com sal aleatorio, para
 * que forca bruta custe caro e para que dois backups da mesma senha nao gerem a
 * mesma chave. O numero de iteracoes segue a recomendacao atual da OWASP para
 * PBKDF2-HMAC-SHA256; ele viaja DENTRO do envelope justamente para que subir
 * esse numero no futuro nao invalide os arquivos ja gerados.
 *
 * Este arquivo nao conhece `chrome`: recebe e devolve dados. E' o que permite
 * testar a criptografia inteira sem navegador.
 */

export const BACKUP_FORMAT = 'lovagit-backup';
export const BACKUP_VERSION = 1;
const ITERATIONS = 600_000;

export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: 'AES-GCM';
  iv: string;
  data: string;
}

/** Senha curta demais nao protege nada; e' melhor recusar do que fingir. */
export const MIN_PASSWORD_LENGTH = 8;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
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

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(payload: unknown, password: string): Promise<BackupEnvelope> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new BackupError(`A senha do backup precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const cifrado = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toBase64(salt) },
    cipher: 'AES-GCM',
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(cifrado)),
  };
}

export function isEnvelope(value: unknown): value is BackupEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<BackupEnvelope>;
  return (
    e.format === BACKUP_FORMAT &&
    typeof e.version === 'number' &&
    typeof e.iv === 'string' &&
    typeof e.data === 'string' &&
    typeof e.kdf?.salt === 'string' &&
    typeof e.kdf?.iterations === 'number'
  );
}

export async function unseal<T>(envelope: unknown, password: string): Promise<T> {
  if (!isEnvelope(envelope)) {
    throw new BackupError('Este arquivo nao e um backup do Lovagit.');
  }
  if (envelope.version > BACKUP_VERSION) {
    throw new BackupError(
      `Este backup foi feito por uma versao mais nova da extensao (formato ${envelope.version}). Atualize antes de importar.`,
    );
  }

  const key = await deriveKey(password, fromBase64(envelope.kdf.salt), envelope.kdf.iterations);
  let plano: ArrayBuffer;
  try {
    plano = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv) as BufferSource },
      key,
      fromBase64(envelope.data),
    );
  } catch {
    // O AES-GCM nao distingue senha errada de arquivo corrompido: as duas
    // falham na verificacao da etiqueta de autenticidade. Como senha errada e'
    // de longe o caso comum, a mensagem fala dela primeiro.
    throw new BackupError('Senha incorreta, ou o arquivo foi alterado depois de gerado.');
  }
  return JSON.parse(new TextDecoder().decode(plano)) as T;
}
