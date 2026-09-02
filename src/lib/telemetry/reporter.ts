import { getSettings } from '../storage';
import type { RepoId } from '../types';
import { classifyError, type Classification } from './classify';
import { buildFingerprint } from './fingerprint';
import { buildIssueBody, buildIssueTitle, buildRecurrenceComment, labelsFor } from './format';
import {
  commentOnIssue,
  createIssue,
  ensureLabels,
  findIssueByFingerprint,
  reopenIssue,
} from './issues';
import { browserSignature, hashRepoId, redactPath, redactStack, redactText } from './redact';
import { DEFAULT_TELEMETRY, type ErrorContext, type ErrorReport, type TelemetrySettings } from './types';

/**
 * Modulo de deteccao de erros.
 *
 * Fluxo: captura -> classifica -> redige -> agenda com janela de desfazer ->
 * abre (ou comenta) o issue no repositorio de destino.
 *
 * Tres travas impedem que isso vire um gerador de spam:
 *  1. so `category: 'bug'` vira issue;
 *  2. fingerprint estavel — a mesma falha comenta no issue existente em vez de
 *     abrir outro, e ocorrencias dentro de 1h nem chegam a fazer requisicao;
 *  3. teto de issues novos por hora.
 */

const KEYS = {
  settings: 'telemetry:settings',
  known: 'telemetry:known',
  log: 'telemetry:log',
  quota: 'telemetry:quota',
  pending: 'telemetry:pending',
} as const;

const LOG_LIMIT = 50;
const RECURRENCE_SILENCE_MS = 60 * 60 * 1000;

export type ReportStatus =
  | 'pendente'
  | 'reportado'
  | 'agrupado'
  | 'cancelado'
  | 'suprimido'
  | 'ignorado'
  | 'falhou';

export interface LogEntry {
  id: string;
  fingerprint: string;
  title: string;
  status: ReportStatus;
  detail: string;
  origin: ErrorReport['origin'];
  category: Classification['category'];
  createdAt: number;
  issueNumber?: number;
  issueUrl?: string;
}

export interface PendingView {
  id: string;
  title: string;
  fingerprint: string;
  origin: ErrorReport['origin'];
  sendAt: number;
  highPriority: boolean;
}

export interface TelemetrySnapshot {
  pending: PendingView[];
  log: LogEntry[];
}

interface KnownIssue {
  issueNumber: number;
  issueUrl: string;
  lastReportedAt: number;
  totalOccurrences: number;
}

interface PendingReport {
  report: ErrorReport;
  reason: string;
  sendAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Forma persistida: sem o timer, que nao sobrevive ao fechamento da pagina. */
interface StoredPending {
  report: ErrorReport;
  reason: string;
  sendAt: number;
}

const pending = new Map<string, PendingReport>();
const listeners = new Set<(snapshot: TelemetrySnapshot) => void>();
let cachedLog: LogEntry[] = [];
/** Evita recursao: uma falha ao reportar nao pode gerar outro relatorio. */
let reportingInFlight = false;
let resumed = false;

async function readKey<T>(key: string, fallback: T): Promise<T> {
  try {
    const stored = await chrome.storage.local.get(key);
    return (stored[key] as T | undefined) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function getTelemetrySettings(): Promise<TelemetrySettings> {
  return { ...DEFAULT_TELEMETRY, ...(await readKey<Partial<TelemetrySettings>>(KEYS.settings, {})) };
}

export async function saveTelemetrySettings(
  patch: Partial<TelemetrySettings>,
): Promise<TelemetrySettings> {
  const next = { ...(await getTelemetrySettings()), ...patch };
  await chrome.storage.local.set({ [KEYS.settings]: next });
  return next;
}

export async function getReportLog(): Promise<LogEntry[]> {
  cachedLog = await readKey<LogEntry[]>(KEYS.log, []);
  return cachedLog;
}

export function subscribeTelemetry(callback: (snapshot: TelemetrySnapshot) => void): () => void {
  listeners.add(callback);
  void resumePendingReports()
    .then(getReportLog)
    .then(() => callback(snapshot()));
  return () => listeners.delete(callback);
}

function snapshot(): TelemetrySnapshot {
  return {
    pending: [...pending.entries()].map(([id, item]) => ({
      id,
      title: buildIssueTitle(item.report),
      fingerprint: item.report.fingerprint,
      origin: item.report.origin,
      sendAt: item.sendAt,
      highPriority: item.report.origin === 'extension',
    })),
    log: cachedLog,
  };
}

function notify(): void {
  const current = snapshot();
  for (const listener of listeners) listener(current);
}

async function appendLog(entry: LogEntry): Promise<void> {
  const log = [entry, ...(await getReportLog()).filter((item) => item.id !== entry.id)].slice(
    0,
    LOG_LIMIT,
  );
  cachedLog = log;
  await chrome.storage.local.set({ [KEYS.log]: log });
  notify();
}

/** A fila tambem vive no storage: fechar o painel dentro da janela de desfazer
 *  nao pode fazer o relatorio evaporar. */
async function persistPending(): Promise<void> {
  const serializable: Record<string, StoredPending> = {};
  for (const [id, item] of pending) {
    serializable[id] = { report: item.report, reason: item.reason, sendAt: item.sendAt };
  }
  await chrome.storage.local.set({ [KEYS.pending]: serializable });
}

async function dropPersistedPending(id: string): Promise<void> {
  const stored = await readKey<Record<string, StoredPending>>(KEYS.pending, {});
  if (!(id in stored)) return;
  delete stored[id];
  await chrome.storage.local.set({ [KEYS.pending]: stored });
}

/**
 * Recoloca na fila o que ficou pendente de uma sessao anterior: o que ja passou
 * da janela sai agora, o resto reagenda pelo tempo que falta.
 */
export async function resumePendingReports(): Promise<void> {
  if (resumed) return;
  resumed = true;
  const stored = await readKey<Record<string, StoredPending>>(KEYS.pending, {});
  const now = Date.now();
  for (const [id, item] of Object.entries(stored)) {
    if (pending.has(id)) continue;
    const delay = Math.max(0, item.sendAt - now);
    pending.set(id, {
      ...item,
      timer: setTimeout(() => void dispatch(id), delay),
    });
  }
  if (Object.keys(stored).length > 0) notify();
}

async function claimIssueQuota(limit: number): Promise<boolean> {
  const now = Date.now();
  const quota = await readKey<{ windowStart: number; created: number }>(KEYS.quota, {
    windowStart: now,
    created: 0,
  });
  const fresh = now - quota.windowStart > 60 * 60 * 1000;
  const next = fresh ? { windowStart: now, created: 0 } : quota;
  if (next.created >= limit) return false;
  await chrome.storage.local.set({
    [KEYS.quota]: { windowStart: next.windowStart, created: next.created + 1 },
  });
  return true;
}

function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return 'desconhecida';
  }
}

function currentBrowser(): string {
  try {
    return browserSignature(navigator.userAgent);
  } catch {
    return 'desconhecido';
  }
}

/** Monta o relatorio ja redigido — nada aqui pode conter dado do usuario. */
export function buildReport(
  error: unknown,
  context: ErrorContext,
  classification: Classification,
  connectedRepoIds: RepoId[],
  now = Date.now(),
): ErrorReport {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawStack = error instanceof Error ? error.stack : undefined;
  const message = redactText(rawMessage, connectedRepoIds);
  const stack = redactStack(rawStack, connectedRepoIds);

  const redactedContext: Record<string, string> = { module: context.module };
  if (context.repoId) redactedContext.repositorio = hashRepoId(context.repoId);
  if (context.path) redactedContext.arquivo = redactPath(context.path);
  if (context.tool) redactedContext.tool = context.tool;
  if (context.providerKind) redactedContext.provedor = context.providerKind;
  if (context.step) redactedContext.etapa = context.step;

  const fingerprint = buildFingerprint({
    origin: classification.origin,
    module: context.module,
    name: classification.name,
    message,
    stack,
  });

  return {
    id: `err_${now.toString(36)}_${fingerprint}`,
    fingerprint,
    origin: classification.origin,
    category: classification.category,
    name: classification.name,
    message,
    stack,
    context: redactedContext,
    status: classification.status,
    extensionVersion: extensionVersion(),
    browser: currentBrowser(),
    createdAt: now,
    occurrences: 1,
  };
}

async function dispatch(id: string): Promise<void> {
  const item = pending.get(id);
  if (!item) return;
  pending.delete(id);
  await dropPersistedPending(id);
  notify();

  const { report, reason } = item;
  const settings = await getTelemetrySettings();
  const known = await readKey<Record<string, KnownIssue>>(KEYS.known, {});
  const existingLocal = known[report.fingerprint];

  reportingInFlight = true;
  try {
    let issueNumber = existingLocal?.issueNumber;
    let issueUrl = existingLocal?.issueUrl;
    let deduplicated = Boolean(issueNumber);

    if (!issueNumber) {
      // Dedupe entre maquinas: o marcador de fingerprint vive no corpo do issue.
      const remote = await findIssueByFingerprint(settings.targetRepoId, report.fingerprint).catch(
        () => null,
      );
      if (remote) {
        issueNumber = remote.number;
        issueUrl = remote.url;
        deduplicated = true;
        if (remote.state === 'closed') {
          await reopenIssue(settings.targetRepoId, remote.number).catch(() => {});
        }
      }
    }

    if (issueNumber) {
      await commentOnIssue(
        settings.targetRepoId,
        issueNumber,
        buildRecurrenceComment(report),
      );
    } else {
      if (!(await claimIssueQuota(settings.maxIssuesPerHour))) {
        await appendLog({
          id: report.id,
          fingerprint: report.fingerprint,
          title: buildIssueTitle(report),
          status: 'suprimido',
          detail: `Teto de ${settings.maxIssuesPerHour} issues novos por hora atingido.`,
          origin: report.origin,
          category: report.category,
          createdAt: report.createdAt,
        });
        return;
      }
      await ensureLabels(settings.targetRepoId);
      const created = await createIssue(settings.targetRepoId, {
        title: buildIssueTitle(report),
        body: buildIssueBody(report, reason),
        labels: labelsFor(report),
      });
      issueNumber = created.number;
      issueUrl = created.url;
      deduplicated = false;

      if (report.origin === 'extension' && created.appliedLabels.length === 0) {
        // Sem push access as labels somem em silencio; o corpo ja diz a prioridade.
        console.warn(
          '[lovagit] Issue aberto sem labels: o token nao tem push access no repositorio de destino.',
        );
      }
    }

    known[report.fingerprint] = {
      issueNumber,
      issueUrl: issueUrl ?? '',
      lastReportedAt: Date.now(),
      totalOccurrences: (existingLocal?.totalOccurrences ?? 0) + report.occurrences,
    };
    await chrome.storage.local.set({ [KEYS.known]: known });

    await appendLog({
      id: report.id,
      fingerprint: report.fingerprint,
      title: buildIssueTitle(report),
      status: deduplicated ? 'agrupado' : 'reportado',
      detail: deduplicated
        ? `Comentado no issue existente #${issueNumber}.`
        : `Issue #${issueNumber} aberto com ${labelsFor(report).join(', ')}.`,
      origin: report.origin,
      category: report.category,
      createdAt: report.createdAt,
      issueNumber,
      issueUrl,
    });
  } catch (deliveryError) {
    await appendLog({
      id: report.id,
      fingerprint: report.fingerprint,
      title: buildIssueTitle(report),
      status: 'falhou',
      detail:
        deliveryError instanceof Error
          ? `Envio falhou: ${deliveryError.message}`
          : 'Envio falhou por motivo desconhecido.',
      origin: report.origin,
      category: report.category,
      createdAt: report.createdAt,
    });
  } finally {
    reportingInFlight = false;
  }
}

/**
 * Ponto de entrada do modulo. Nunca lanca: um erro no caminho de reportar erro
 * viraria um laco infinito.
 */
export async function captureError(error: unknown, context: ErrorContext): Promise<void> {
  if (reportingInFlight) return;
  try {
    const classification = classifyError(error);
    if (classification.category === 'ignored') return;

    const settings = await getTelemetrySettings();
    const appSettings = await getSettings().catch(() => null);
    const connectedRepoIds = appSettings?.connectedRepoIds ?? [];
    const report = buildReport(error, context, classification, connectedRepoIds);

    if (classification.category !== 'bug') {
      await appendLog({
        id: report.id,
        fingerprint: report.fingerprint,
        title: buildIssueTitle(report),
        status: 'ignorado',
        detail: `${classification.reason} Nao vira issue por nao ser defeito.`,
        origin: report.origin,
        category: report.category,
        createdAt: report.createdAt,
      });
      return;
    }

    if (!settings.enabled) {
      await appendLog({
        id: report.id,
        fingerprint: report.fingerprint,
        title: buildIssueTitle(report),
        status: 'suprimido',
        detail: 'Relato automatico desligado nas configuracoes.',
        origin: report.origin,
        category: report.category,
        createdAt: report.createdAt,
      });
      return;
    }

    // Mesma falha ja na fila: so conta a ocorrencia.
    for (const item of pending.values()) {
      if (item.report.fingerprint === report.fingerprint) {
        item.report.occurrences += 1;
        await persistPending();
        notify();
        return;
      }
    }

    // Ja reportada ha pouco: nem chega a fazer requisicao.
    const known = await readKey<Record<string, KnownIssue>>(KEYS.known, {});
    const entry = known[report.fingerprint];
    if (entry && Date.now() - entry.lastReportedAt < RECURRENCE_SILENCE_MS) {
      known[report.fingerprint] = {
        ...entry,
        totalOccurrences: entry.totalOccurrences + 1,
      };
      await chrome.storage.local.set({ [KEYS.known]: known });
      await appendLog({
        id: report.id,
        fingerprint: report.fingerprint,
        title: buildIssueTitle(report),
        status: 'agrupado',
        detail: `Ja reportado no issue #${entry.issueNumber} na ultima hora.`,
        origin: report.origin,
        category: report.category,
        createdAt: report.createdAt,
        issueNumber: entry.issueNumber,
        issueUrl: entry.issueUrl,
      });
      return;
    }

    const sendAt = Date.now() + settings.undoSeconds * 1000;
    pending.set(report.id, {
      report,
      reason: classification.reason,
      sendAt,
      timer: setTimeout(() => void dispatch(report.id), settings.undoSeconds * 1000),
    });
    await persistPending();
    notify();
  } catch (internal) {
    console.error('[lovagit] modulo de erros falhou ao capturar', internal);
  }
}

export function cancelPendingReport(id: string): void {
  const item = pending.get(id);
  if (!item) return;
  clearTimeout(item.timer);
  pending.delete(id);
  void dropPersistedPending(id);
  void appendLog({
    id: item.report.id,
    fingerprint: item.report.fingerprint,
    title: buildIssueTitle(item.report),
    status: 'cancelado',
    detail: 'Envio cancelado por voce antes de sair da maquina.',
    origin: item.report.origin,
    category: item.report.category,
    createdAt: item.report.createdAt,
  });
}

export function sendPendingNow(id: string): void {
  const item = pending.get(id);
  if (!item) return;
  clearTimeout(item.timer);
  void dispatch(id);
}

export function previewPendingReport(id: string): { title: string; body: string } | null {
  const item = pending.get(id);
  if (!item) return null;
  return {
    title: buildIssueTitle(item.report),
    body: buildIssueBody(item.report, item.reason),
  };
}

/**
 * Handlers globais: pegam o que escapou de todo try/catch da aplicacao.
 * Devolve o disposer — em StrictMode o efeito roda duas vezes, e sem remover o
 * primeiro handler cada erro seria capturado em duplicidade.
 */
export function installErrorHandlers(module: string): () => void {
  const onError = (event: ErrorEvent) => {
    void captureError(event.error ?? new Error(event.message), { module });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    void captureError(event.reason, { module });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
