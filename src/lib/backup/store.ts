import { exportSecrets, importSecrets } from '../vault';
import { seal, unseal, type BackupEnvelope } from './envelope';

/**
 * Backup das configuracoes.
 *
 * O navegador apaga TUDO que e' da extensao quando ela e' desinstalada —
 * `chrome.storage.local`, `chrome.storage.sync` e o IndexedDB do cofre. Isso
 * nao tem contorno por API: para o Chrome, os dados pertencem a extensao, nao
 * ao usuario. Um arquivo que o usuario guarda e' o unico jeito de atravessar
 * uma reinstalacao.
 *
 * (Trocar a versao da extensao NAO exige desinstalar: basta recarregar em
 * `chrome://extensions`, e nada se perde. O backup e' para o resto — perfil
 * recriado, pasta movida, maquina nova.)
 */

export interface BackupPayload {
  extensionVersion: string;
  /** `chrome.storage.local`, menos o que e' cache ou esta em transito. */
  storage: Record<string, unknown>;
  /** Nome do segredo -> valor em texto puro. Protegido pela senha do envelope. */
  secrets: Record<string, string>;
}

/**
 * O que NAO vai no backup.
 *
 * Sao duas familias, por motivos diferentes. Cache (`:map`, o build publicado)
 * fica de fora porque se refaz sozinho e e' o que mais pesa no arquivo. Estado
 * em transito (`:pending`, a fila da telemetria) fica de fora porque restaurar
 * um turno pela metade ou uma fila de relatos antigos produziria acao sem
 * contexto na instalacao nova.
 *
 * Os blobs `secret:` tambem saem: sao inuteis sem a chave mestra que ficou para
 * tras. O conteudo deles viaja decifrado em `secrets`.
 */
function ehDescartavel(chave: string): boolean {
  return (
    chave.startsWith('secret:') ||
    chave === 'extension:latest-build' ||
    chave === 'telemetry:pending' ||
    chave.endsWith(':map') ||
    chave.endsWith(':pending')
  );
}

function versaoInstalada(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

export function selectForBackup(tudo: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(tudo).filter(([chave]) => !ehDescartavel(chave)));
}

export async function createBackup(password: string): Promise<BackupEnvelope> {
  const [tudo, secrets] = await Promise.all([chrome.storage.local.get(null), exportSecrets()]);
  const payload: BackupPayload = {
    extensionVersion: versaoInstalada(),
    storage: selectForBackup(tudo),
    secrets,
  };
  return seal(payload, password);
}

export interface RestoreSummary {
  keys: number;
  secrets: number;
  fromVersion: string;
}

/**
 * Restaura por cima do que existe.
 *
 * Substitui as chaves que o backup traz e deixa as demais em paz — restaurar
 * nao pode apagar um repositorio conectado depois do backup ter sido feito.
 */
export async function restoreBackup(
  envelope: unknown,
  password: string,
): Promise<RestoreSummary> {
  const payload = await unseal<BackupPayload>(envelope, password);
  const storage = payload.storage ?? {};
  const secrets = payload.secrets ?? {};

  await chrome.storage.local.set(storage);
  const gravados = await importSecrets(secrets);

  return {
    keys: Object.keys(storage).length,
    secrets: gravados,
    fromVersion: payload.extensionVersion ?? 'desconhecida',
  };
}

/** Nome do arquivo, com a data para varios backups conviverem na mesma pasta. */
export function backupFileName(agora = new Date()): string {
  const dia = agora.toISOString().slice(0, 10);
  return `lovagit-backup-${dia}.json`;
}
