import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createProvider } from '../lib/ai/registry';
import { runAgent, type AgentEvent } from '../lib/agent/loop';
import { createScope } from '../lib/agent/isolation';
import { applyChangesToMap } from '../lib/github/mapper';
import { captureError } from '../lib/errlog';
import { applyChanges, restoreCheckpoint } from '../lib/github/writer';
import {
  addCheckpoint,
  clearPendingChanges,
  getChat,
  getCheckpoints,
  getPendingChanges,
  getRepoMap,
  saveChat,
  savePendingChanges,
  saveRepoMap,
} from '../lib/storage';
import type { ChatMessage, Checkpoint, PendingFileChange, RepoRef, Settings } from '../lib/types';
import { DiffView } from './DiffView';
import { Button, ErrorNote, RichText, Spinner } from './ui';

interface ChatViewProps {
  repo: RepoRef;
  settings: Settings;
  onRequestSettings: () => void;
  onRemap: () => void;
}

const TOOL_LABEL: Record<string, string> = {
  list_directory: 'listou',
  read_file: 'leu',
  search_code: 'buscou',
  write_file: 'escreveu',
  delete_file: 'removeu',
  commit_changes: 'commitou',
};

export function ChatView({ repo, settings, onRequestSettings, onRemap }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [pending, setPending] = useState<PendingFileChange[]>([]);
  const [pendingMessage, setPendingMessage] = useState('');
  const [streaming, setStreaming] = useState('');
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeProvider = useMemo(
    () => settings.providers.find((provider) => provider.id === settings.activeProviderId) ?? null,
    [settings],
  );

  // Troca de repositorio = troca completa de estado. Nada e' reaproveitado.
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setPending([]);
    setPendingMessage('');
    setStreaming('');
    setError(null);
    void (async () => {
      const [chat, cps, pendingSet] = await Promise.all([
        getChat(repo.id),
        getCheckpoints(repo.id),
        getPendingChanges(repo.id),
      ]);
      if (cancelled) return;
      setMessages(chat);
      setCheckpoints(cps);
      setPending(pendingSet?.changes ?? []);
      setPendingMessage(pendingSet?.message ?? '');
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [repo.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming, status]);

  const persistCheckpoint = useCallback(
    async (checkpoint: Checkpoint, changes: PendingFileChange[]) => {
      const next = await addCheckpoint(checkpoint);
      setCheckpoints(next);
      const map = await getRepoMap(repo.id);
      if (map) {
        await saveRepoMap(
          applyChangesToMap(
            map,
            changes.map((change) => ({ path: change.path, action: change.action })),
            checkpoint.commitSha,
          ),
        );
      }
      await clearPendingChanges(repo.id);
      setPending([]);
      setPendingMessage('');
    },
    [repo.id],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || running) return;
    if (!activeProvider) {
      setError('Nenhuma IA conectada. Configure um provedor nas configuracoes.');
      return;
    }

    const map = await getRepoMap(repo.id);
    if (!map) {
      setError('Este repositorio ainda nao foi mapeado. Use "Remapear".');
      return;
    }

    setInput('');
    setError(null);
    setRunning(true);
    setStreaming('');
    const controller = new AbortController();
    abortRef.current = controller;

    const collectedChanges = new Map<string, PendingFileChange>();
    const producedMessages: ChatMessage[] = [];
    let history: ChatMessage[] = [];

    try {
      const provider = await createProvider(activeProvider);
      const scope = createScope(repo);
      history = await getChat(repo.id);

      const onEvent = (event: AgentEvent) => {
        switch (event.type) {
          case 'status':
            setStatus(event.text);
            break;
          case 'assistant-delta':
            setStreaming((prev) => prev + event.text);
            break;
          case 'message':
            setStreaming('');
            producedMessages.push(event.message);
            setMessages((prev) => [...prev, event.message]);
            break;
          case 'tool-start':
            setStatus(`${TOOL_LABEL[event.call.name] ?? event.call.name} ${String(event.call.input.path ?? event.call.input.query ?? '')}`);
            break;
          case 'pending-changed':
            for (const change of event.changes) collectedChanges.set(change.path, change);
            setPending(event.changes);
            break;
          case 'awaiting-approval':
            setPendingMessage(event.message);
            void savePendingChanges({
              repoId: repo.id,
              changes: event.changes,
              message: event.message,
              createdAt: Date.now(),
            });
            break;
          case 'committed':
            void persistCheckpoint(event.result.checkpoint, [...collectedChanges.values()]);
            collectedChanges.clear();
            break;
          case 'error':
            setError(event.error);
            break;
          case 'done':
            setStatus('');
            break;
        }
      };

      await runAgent({
        scope,
        map,
        history,
        userText: text,
        provider,
        autoApply: settings.autoApplyChanges,
        connectedRepoIds: settings.connectedRepoIds,
        signal: controller.signal,
        onEvent,
      });
    } catch (caught) {
      if ((caught as Error)?.name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      captureError(caught, {
        module: 'sidepanel/ChatView',
        repoId: repo.id,
        step: 'conversa',
        providerKind: activeProvider.kind,
      });
    } finally {
      // Cancelar ou falhar no meio nao pode apagar o que ja foi dito no chat.
      if (producedMessages.length > 0) {
        await saveChat(repo.id, [...history, ...producedMessages]);
      }
      setRunning(false);
      setStatus('');
      setStreaming('');
      abortRef.current = null;
    }
  }, [activeProvider, input, persistCheckpoint, repo, running, settings]);

  const approvePending = useCallback(async () => {
    if (pending.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const result = await applyChanges(
        repo,
        repo.defaultBranch,
        pending,
        pendingMessage || 'chore: alteracoes via Lovagit',
      );
      await persistCheckpoint(result.checkpoint, pending);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      captureError(caught, {
        module: 'sidepanel/ChatView',
        repoId: repo.id,
        step: 'commit',
      });
    } finally {
      setApplying(false);
    }
  }, [pending, pendingMessage, persistCheckpoint, repo]);

  const discardPending = useCallback(async () => {
    await clearPendingChanges(repo.id);
    setPending([]);
    setPendingMessage('');
  }, [repo.id]);

  const restore = useCallback(
    async (checkpoint: Checkpoint) => {
      setApplying(true);
      setError(null);
      try {
        const result = await restoreCheckpoint(repo, checkpoint);
        const next = await addCheckpoint(result.checkpoint);
        setCheckpoints(next);
        onRemap();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        captureError(caught, {
          module: 'sidepanel/ChatView',
          repoId: repo.id,
          step: 'restauracao',
        });
      } finally {
        setApplying(false);
      }
    },
    [onRemap, repo],
  );

  const clearChat = useCallback(async () => {
    await saveChat(repo.id, []);
    setMessages([]);
  }, [repo.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="rounded-lg border border-dashed border-ink-700 p-4 text-xs text-ink-400">
            <p className="mb-2 text-ink-200">Chat isolado de {repo.id}</p>
            <p>
              A IA conhece apenas este repositorio: arvore de arquivos, stack detectada e
              arquivos-chave ja mapeados. Peca uma alteracao em linguagem natural — ela le o
              codigo antes de escrever, cria uma branch de backup e commita em{' '}
              <code className="font-mono text-ink-200">{repo.defaultBranch}</code>.
            </p>
          </div>
        )}

        {messages.map((message) => {
          if (message.role === 'user') {
            return (
              <div key={message.id} className="ml-6 rounded-lg bg-ink-800 px-3 py-2">
                <RichText text={message.content} />
              </div>
            );
          }
          if (message.role === 'tool') {
            return (
              <div key={message.id} className="flex flex-wrap gap-1">
                {(message.toolResults ?? []).map((result) => (
                  <span
                    key={result.toolCallId}
                    title={result.content.slice(0, 400)}
                    className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                      result.isError
                        ? 'border-red-500/30 bg-red-500/10 text-red-300'
                        : 'border-ink-700 bg-ink-900 text-ink-400'
                    }`}
                  >
                    {TOOL_LABEL[result.name] ?? result.name}
                  </span>
                ))}
              </div>
            );
          }
          if (!message.content && !message.toolCalls) return null;
          return (
            <div key={message.id} className="space-y-1">
              {message.content && <RichText text={message.content} />}
              {(message.toolCalls ?? []).map((call) => (
                <div key={call.id} className="font-mono text-[10px] text-ink-400">
                  → {TOOL_LABEL[call.name] ?? call.name}{' '}
                  {String(call.input.path ?? call.input.query ?? '')}
                </div>
              ))}
            </div>
          );
        })}

        {streaming && <RichText text={streaming} />}
        {running && <Spinner label={status || 'Trabalhando...'} />}
        {error && <ErrorNote>{error}</ErrorNote>}

        {pending.length > 0 && (
          <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-amber-300">
                {pending.length} alteracao(oes) pendente(s)
              </span>
              {!running && (
                <div className="flex gap-1">
                  <Button variant="primary" disabled={applying} onClick={() => void approvePending()}>
                    {applying ? 'Aplicando...' : `Commitar em ${repo.defaultBranch}`}
                  </Button>
                  <Button variant="ghost" disabled={applying} onClick={() => void discardPending()}>
                    Descartar
                  </Button>
                </div>
              )}
            </div>
            {pendingMessage && (
              <p className="font-mono text-[11px] text-ink-400">{pendingMessage.split('\n')[0]}</p>
            )}
            {pending.map((change) => (
              <DiffView key={change.path} change={change} />
            ))}
            <p className="text-[10px] text-ink-400">
              Ao commitar, uma branch de backup da {repo.defaultBranch} e criada antes — da para
              voltar depois pelo historico abaixo.
            </p>
          </div>
        )}

        {checkpoints.length > 0 && (
          <details className="rounded-lg border border-ink-700 bg-ink-900">
            <summary className="cursor-pointer px-3 py-2 text-xs text-ink-400">
              Historico e backups ({checkpoints.length})
            </summary>
            <div className="space-y-2 border-t border-ink-700 p-2">
              {checkpoints.map((checkpoint) => (
                <div key={checkpoint.id} className="rounded-md border border-ink-700 p-2">
                  <p className="text-[11px] text-ink-200">{checkpoint.message.split('\n')[0]}</p>
                  <p className="font-mono text-[10px] text-ink-400">
                    {checkpoint.commitSha.slice(0, 7)} · {checkpoint.files.length} arquivo(s) ·{' '}
                    {new Date(checkpoint.createdAt).toLocaleString('pt-BR')}
                  </p>
                  <p className="truncate font-mono text-[10px] text-ink-400">
                    backup: {checkpoint.backupBranch}
                  </p>
                  <div className="mt-1 flex gap-1">
                    <Button
                      variant="ghost"
                      disabled={applying}
                      onClick={() => void restore(checkpoint)}
                      title={`Restaura ${repo.defaultBranch} para o estado da branch de backup`}
                    >
                      Voltar para este backup
                    </Button>
                    <a
                      className="rounded-md px-2.5 py-1.5 text-xs text-ink-400 hover:text-ink-200"
                      href={`${repo.htmlUrl}/commit/${checkpoint.commitSha}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Ver commit
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="border-t border-ink-700 bg-ink-900 p-2">
        {!activeProvider && (
          <div className="mb-2 flex items-center justify-between rounded-md border border-ink-700 bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400">
            Nenhuma IA conectada.
            <Button variant="ghost" onClick={onRequestSettings}>
              Conectar
            </Button>
          </div>
        )}
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={3}
          placeholder={`O que voce quer mudar em ${repo.name}?`}
          className="w-full resize-none rounded-md border border-ink-700 bg-ink-950 p-2 text-[13px] text-ink-200 outline-none placeholder:text-ink-600 focus:border-ink-600"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="truncate font-mono text-[10px] text-ink-400">
            {activeProvider ? `${activeProvider.label} · ${activeProvider.model}` : 'sem IA'}
          </span>
          <div className="flex gap-1">
            <Button variant="ghost" onClick={() => void clearChat()} disabled={running}>
              Limpar
            </Button>
            {running ? (
              <Button variant="danger" onClick={() => abortRef.current?.abort()}>
                Parar
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void send()} disabled={!input.trim()}>
                Enviar
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
