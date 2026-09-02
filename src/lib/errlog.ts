/**
 * Log local de erros. Antes existia um modulo que publicava issues em um
 * repositorio remoto; foi removido por ser complexidade desproporcional ao
 * estagio do projeto. Agora os erros ficam apenas neste arquivo de log local
 * (chrome.storage.local), legivel em debug. Nunca lanca: o caminho de captura
 * nao pode derrubar a aplicacao.
 */

const KEY = 'errlog';
const LIMIT = 100;

export interface ErrorContext {
  /** Modulo onde o erro apareceu, ex.: 'sidepanel/ChatView'. */
  module: string;
  repoId?: string;
  path?: string;
  tool?: string;
  providerKind?: string;
  step?: string;
}

export interface ErrorLogEntry {
  module: string;
  name: string;
  message: string;
  context: ErrorContext;
  createdAt: number;
}

export function captureError(error: unknown, context: ErrorContext): void {
  try {
    const entry: ErrorLogEntry = {
      module: context.module,
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      context,
      createdAt: Date.now(),
    };
    void chrome.storage.local
      .get(KEY)
      .then((stored) => {
        const list = (stored[KEY] as ErrorLogEntry[] | undefined) ?? [];
        const next = [entry, ...list].slice(0, LIMIT);
        return chrome.storage.local.set({ [KEY]: next });
      })
      .catch(() => {
        // Storage indisponivel: engole. Nunca lancar daqui.
      });
  } catch {
    // Erro ao capturar erro: engole por construcao.
  }
}

export async function getErrorLog(): Promise<ErrorLogEntry[]> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return (stored[KEY] as ErrorLogEntry[] | undefined) ?? [];
  } catch {
    return [];
  }
}

/**
 * Handlers globais: pegam o que escapou de todo try/catch. Devolve o disposer
 * para remover os ouvintes (em StrictMode o efeito roda duas vezes).
 */
export function installErrorHandlers(module: string): () => void {
  const onError = (event: ErrorEvent) => {
    captureError(event.error ?? new Error(event.message), { module });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    captureError(event.reason, { module });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
