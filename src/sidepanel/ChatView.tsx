import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createProvider } from '../lib/ai/registry';
import { runAgent, type AgentEvent } from '../lib/agent/loop';
import { createScope } from '../lib/agent/isolation';
import { applyChangesToMap } from '../lib/github/mapper';
import { getServersForRepo } from '../lib/mcp/registry';
import { captureError } from '../lib/telemetry/reporter';
import { RETRY_DELAY_SECONDS, shouldAutoRetry } from '../lib/agent/retry';
import {
  clearRepoMemory,
  forgetMemoryEntry,
  loadMemory,
  recordMemory,
} from '../lib/memory/store';
import type { MemoryEntry } from '../lib/memory/types';
import { applyChanges, defaultCommitMessage, restoreCheckpoint } from '../lib/github/writer';
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
import type {
  ChatMessage,
  Checkpoint,
  PendingFileChange,
  RepoRef,
  Settings,
  ToolResult,
  TurnImage,
} from '../lib/types';
import { detectVisionSupport, describeVision, type VisionSupport } from '../lib/ai/vision';
import { AssistantStep } from './AssistantStep';
import { DiffView } from './DiffView';
import { TOOL_LABEL } from './toolTrace';
import { toPreviewUrl, toTurnImages, useAttachments } from './useAttachments';
import { Button, ErrorNote, RichText, Spinner } from './ui';

interface ChatViewProps {
  repo: RepoRef;
  settings: Settings;
  onRequestSettings: () => void;
  onRemap: () => void;
}

const MEMORY_LABEL: Record<string, string> = {
  request: 'pedido',
  decision: 'decisao',
  action: 'alteracao',
};

export function ChatView({ repo, settings, onRequestSettings, onRemap }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [pending, setPending] = useState<PendingFileChange[]>([]);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [pendingMessage, setPendingMessage] = useState('');
  const [streaming, setStreaming] = useState('');
  /** Raciocinio do turno em andamento — some assim que a resposta chega. */
  const [reasoning, setReasoning] = useState('');
  /** Reenvio automatico agendado: texto original e segundos restantes. */
  const [retry, setRetry] = useState<{
    text: string;
    images: TurnImage[];
    secondsLeft: number;
  } | null>(null);
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { attachments, attachError, addFiles, addFromClipboard, remove, clear } =
    useAttachments();
  /** O modelo ativo enxerga imagem? `unknown` = nao da para afirmar. */
  const [vision, setVision] = useState<VisionSupport>('unknown');

  // Resultado de cada tool, indexado pelo id da chamada: e' assim que a linha
  // da acao consegue abrir o conteudo do arquivo que ela leu.
  const toolResults = useMemo(() => {
    const porChamada = new Map<string, ToolResult>();
    for (const message of messages) {
      for (const result of message.toolResults ?? []) porChamada.set(result.toolCallId, result);
    }
    return porChamada;
  }, [messages]);

  const activeProvider = useMemo(
    () => settings.providers.find((provider) => provider.id === settings.activeProviderId) ?? null,
    [settings],
  );

  // Descobre o suporte a imagem do modelo ativo. Roda na troca de provedor, e
  // nao no envio, para o aviso estar na tela ANTES de voce anexar.
  useEffect(() => {
    let cancelado = false;
    if (!activeProvider) {
      setVision('unknown');
      return;
    }
    void detectVisionSupport(activeProvider).then((suporte) => {
      if (!cancelado) setVision(suporte);
    });
    return () => {
      cancelado = true;
    };
  }, [activeProvider]);

  /** Grava um fato e recarrega o painel. Falha de gravacao (cota, por exemplo)
   *  nao pode sumir em silencio: memoria que nao grava e' pior que nenhuma. */
  const persistMemory = useCallback(
    async (entry: Parameters<typeof recordMemory>[0]) => {
      try {
        await recordMemory(entry);
        setMemory(await loadMemory(repo.id));
        setMemoryError(null);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setMemoryError(`A memoria nao foi gravada: ${message}`);
        void captureError(caught, {
          module: 'sidepanel/ChatView',
          repoId: repo.id,
          step: 'memoria',
        });
      }
    },
    [repo.id],
  );

  const forgetEntry = useCallback(
    async (id: string) => {
      try {
        setMemory(await forgetMemoryEntry(repo.id, id));
        setMemoryError(null);
      } catch (caught) {
        setMemoryError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [repo.id],
  );

  const forgetAll = useCallback(async () => {
    try {
      await clearRepoMemory(repo.id);
      setMemory([]);
      setMemoryError(null);
    } catch (caught) {
      setMemoryError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [repo.id]);

  // Troca de repositorio = troca completa de estado. Nada e' reaproveitado.
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setPending([]);
    setPendingMessage('');
    setStreaming('');
    setReasoning('');
    setRetry(null);
    setMemory([]);
    setMemoryError(null);
    setMemoryOpen(false);
    setError(null);
    void (async () => {
      const [chat, cps, pendingSet, mem] = await Promise.all([
        getChat(repo.id),
        getCheckpoints(repo.id),
        getPendingChanges(repo.id),
        loadMemory(repo.id),
      ]);
      if (cancelled) return;
      setMessages(chat);
      setCheckpoints(cps);
      setPending(pendingSet?.changes ?? []);
      setPendingMessage(pendingSet?.message ?? '');
      setMemory(mem);
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
      // Unico ponto onde um commit vira memoria. Passam por aqui tanto o
      // commit do agente quanto o aprovado no botao — e o segundo, que e' o
      // caminho de quem revisa antes de commitar, nao gravava nada.
      await persistMemory({
        repoId: repo.id,
        kind: 'action',
        summary: checkpoint.message.split('\n')[0],
        refs: {
          commitSha: checkpoint.commitSha,
          paths: changes.map((change) => change.path),
        },
      });
    },
    [persistMemory, repo.id],
  );

  const runTurn = useCallback(
    async (text: string, reenvioAutomatico = false, imagens: TurnImage[] = []) => {
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

      setError(null);
      setReasoning('');
      setRunning(true);
      setStreaming('');
      const controller = new AbortController();
      abortRef.current = controller;

      const collectedChanges = new Map<string, PendingFileChange>();
      const producedMessages: ChatMessage[] = [];
      let history: ChatMessage[] = [];
      // Reenviar depois de um commit repetiria trabalho ja gravado no repositorio.
      let commitouNesteTurno = false;

      try {
        const provider = await createProvider(activeProvider);
        const scope = createScope(repo);
        history = await getChat(repo.id);
        // So os servidores MCP habilitados para ESTE repositorio.
        const mcpServers = await getServersForRepo(repo.id);
        // Le a memoria ANTES do turno: o que for gravado agora vale do proximo em
        // diante, para o modelo nunca ver o proprio registro no mesmo prompt.
        const memoriaAtual = await loadMemory(repo.id);

        const onEvent = (event: AgentEvent) => {
          switch (event.type) {
            case 'status':
              setStatus(event.text);
              break;
            case 'assistant-delta':
              setStreaming((prev) => prev + event.text);
              break;
            case 'reasoning-delta':
              setReasoning((prev) => prev + event.text);
              break;
            case 'message':
              setStreaming('');
              setReasoning('');
              producedMessages.push(event.message);
              setMessages((prev) => [...prev, event.message]);
              break;
            case 'tool-start':
              setStatus(
                `${TOOL_LABEL[event.call.name] ?? event.call.name} ${String(event.call.input.path ?? event.call.input.query ?? '')}`,
              );
              break;
            case 'pending-changed':
              for (const change of event.changes) collectedChanges.set(change.path, change);
              setPending(event.changes);
              break;
            case 'awaiting-approval': {
              // Sem mensagem proposta pelo modelo, deriva uma das proprias
              // alteracoes — e ela fica editavel antes de virar historico.
              const proposta = event.commitMessage ?? defaultCommitMessage(event.changes);
              setPendingMessage(proposta);
              void savePendingChanges({
                repoId: repo.id,
                changes: event.changes,
                message: proposta,
                createdAt: Date.now(),
              });
              break;
            }
            case 'memory':
              void persistMemory(event.entry);
              break;
            case 'committed':
              commitouNesteTurno = true;
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
          images: imagens,
          provider,
          autoApply: settings.autoApplyChanges,
          connectedRepoIds: settings.connectedRepoIds,
          mcpServers,
          memory: memoriaAtual,
          signal: controller.signal,
          onEvent,
        });
      } catch (caught) {
        const cancelado = (caught as Error)?.name === 'AbortError';
        if (!cancelado) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
        void captureError(caught, {
          module: 'sidepanel/ChatView',
          repoId: repo.id,
          step: 'conversa',
          providerKind: activeProvider.kind,
        });

        if (
          shouldAutoRetry({
            enabled: settings.autoRetryOnFailure,
            error: caught,
            alreadyRetried: reenvioAutomatico,
            committed: commitouNesteTurno,
          })
        ) {
          // O reenvio leva as MESMAS imagens: sem isso a segunda tentativa
        // mandaria a pergunta sem a tela sobre a qual ela fala.
        setRetry({ text, images: imagens, secondsLeft: RETRY_DELAY_SECONDS });
        }
      } finally {
        // Cancelar ou falhar no meio nao pode apagar o que ja foi dito no chat.
        if (producedMessages.length > 0) {
          await saveChat(repo.id, [...history, ...producedMessages]);
        }
        setRunning(false);
        setStatus('');
        setStreaming('');
        setReasoning('');
        abortRef.current = null;
      }
    },
    [activeProvider, persistCheckpoint, persistMemory, repo, running, settings],
  );

  // `runTurn` muda de identidade a cada render; a contagem do reenvio nao pode
  // reiniciar por causa disso.
  const runTurnRef = useRef(runTurn);
  useEffect(() => {
    runTurnRef.current = runTurn;
  });

  useEffect(() => {
    if (!retry) return;
    if (retry.secondsLeft <= 0) {
      setRetry(null);
      void runTurnRef.current(retry.text, true, retry.images);
      return;
    }
    const timer = setTimeout(() => {
      setRetry((atual) => (atual ? { ...atual, secondsLeft: atual.secondsLeft - 1 } : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [retry]);

  /** Modelo que comprovadamente nao le imagem nao recebe anexo: a chamada
   *  falharia, ou pior, ele responderia ignorando a imagem sem dizer nada. */
  const blockedByVision = attachments.length > 0 && vision === 'no';

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || running || blockedByVision) return;
    // Mandar na mao cancela um reenvio agendado: quem manda e o usuario.
    setRetry(null);
    setInput('');
    const imagens = toTurnImages(attachments);
    clear();
    void runTurn(text, false, imagens);
  }, [attachments, blockedByVision, clear, input, runTurn, running]);

  const approvePending = useCallback(async () => {
    if (pending.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const result = await applyChanges(
        repo,
        repo.defaultBranch,
        pending,
        pendingMessage.trim() || defaultCommitMessage(pending),
      );
      await persistCheckpoint(result.checkpoint, pending);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      void captureError(caught, {
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
        // Sem isto a memoria continuaria afirmando que um trabalho existe
        // depois de ele ter sido desfeito — memoria que mente e' pior que
        // memoria vazia.
        await persistMemory({
          repoId: repo.id,
          kind: 'action',
          summary: `Restaurada a ${repo.defaultBranch} para o backup ${checkpoint.backupBranch}`,
          refs: { commitSha: result.checkpoint.commitSha },
        });
        onRemap();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        void captureError(caught, {
          module: 'sidepanel/ChatView',
          repoId: repo.id,
          step: 'restauracao',
        });
      } finally {
        setApplying(false);
      }
    },
    [onRemap, persistMemory, repo],
  );

  const clearChat = useCallback(async () => {
    await saveChat(repo.id, []);
    setMessages([]);
  }, [repo.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Historico colado no topo, fora do scroll: no fim da conversa ele ficava
          longe justamente quando a conversa e longa — que e quando se quer
          voltar para um backup. */}
      {checkpoints.length > 0 && (
        <details className="glass shrink-0 border-b border-ink-700 bg-ink-900">
          <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-ink-400">
            Historico e backups ({checkpoints.length})
          </summary>
          <div className="max-h-64 space-y-2 overflow-y-auto border-t border-ink-700 p-2">
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

      {/* Memoria colada no topo, fora do scroll: e' um atalho de consulta, nao
          um trecho da conversa. Dentro do scroll ela subia junto com as
          mensagens e deixava de estar a um clique. */}
      <details
        className="glass shrink-0 border-b border-ink-700 bg-ink-900"
        open={memoryOpen}
        onToggle={(event) => setMemoryOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-ink-400">
          Memoria deste repositorio ({memory.length})
        </summary>
        <div className="max-h-64 space-y-2 overflow-y-auto border-t border-ink-700 p-2">
          {memoryError && <ErrorNote>{memoryError}</ErrorNote>}
          {memory.length === 0 ? (
            <p className="text-[10px] text-ink-400">
              Nada guardado ainda. A memoria enche quando um pedido seu vira alteracao
              commitada, ou quando a IA anota uma decisao no meio do caminho.
            </p>
          ) : (
            <>
              <p className="text-[10px] text-ink-400">
                O que a IA leva para as proximas conversas. Se alguma linha estiver errada,
                apague: memoria errada e repetida em todo prompt, e ai atrapalha mais do que
                ajuda.
              </p>
              {[...memory].reverse().map((entry) => (
                <div key={entry.id} className="rounded-md border border-ink-700 p-2">
                  <p className="text-[11px] text-ink-200">{entry.summary}</p>
                  <p className="font-mono text-[10px] text-ink-400">
                    {MEMORY_LABEL[entry.kind]} ·{' '}
                    {new Date(entry.createdAt).toLocaleDateString('pt-BR')}
                    {entry.level > 0 && ' · comprimida'}
                    {entry.refs?.commitSha ? ` · ${entry.refs.commitSha.slice(0, 7)}` : ''}
                  </p>
                  {entry.detail && entry.detail !== entry.summary && (
                    <p className="mt-1 text-[10px] text-ink-400">{entry.detail}</p>
                  )}
                  <div className="mt-1">
                    <Button variant="ghost" onClick={() => void forgetEntry(entry.id)}>
                      Esquecer
                    </Button>
                  </div>
                </div>
              ))}
              <Button variant="ghost" onClick={() => void forgetAll()}>
                Esquecer tudo deste repositorio
              </Button>
            </>
          )}
        </div>
      </details>

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
                {(message.attachments ?? []).length > 0 && (
                  <p className="mt-1 font-mono text-[10px] text-ink-400">
                    {message.attachments?.length} imagem(ns) enviada(s) neste turno
                  </p>
                )}
              </div>
            );
          }
          // O resultado nao tem bloco proprio: ele abre dentro da linha da
          // acao que o gerou. A badge separada repetia o verbo sem dizer em
          // qual arquivo, e o conteudo nao aparecia em lugar nenhum.
          if (message.role === 'tool') return null;
          return <AssistantStep key={message.id} message={message} results={toolResults} />;
        })}

        {/* Fase de pensamento: sem isso a tela fica parada em modelo lento, e e
            justamente nesse silencio que o intermediario derruba a conexao. */}
        {reasoning && !streaming && (
          <div className="rounded-md border border-ink-800 bg-ink-900/60">
            <p className="px-2 py-1 text-[10px] text-ink-500">Raciocinando...</p>
            <div className="max-h-32 overflow-y-auto whitespace-pre-wrap border-t border-ink-800 p-2 font-mono text-[10px] leading-relaxed text-ink-400">
              {reasoning}
            </div>
          </div>
        )}
        {streaming && <RichText text={streaming} />}
        {running && <Spinner label={status || 'Trabalhando...'} />}
        {error && <ErrorNote>{error}</ErrorNote>}

        {retry && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-ink-700 bg-ink-900 p-2 text-xs text-ink-300">
            <span>Falha passageira. Reenviando em {retry.secondsLeft}s...</span>
            <Button variant="ghost" onClick={() => setRetry(null)}>
              Cancelar
            </Button>
          </div>
        )}

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
            <label className="block">
              <span className="mb-1 block text-[10px] text-ink-400">Mensagem do commit</span>
              <textarea
                value={pendingMessage}
                rows={2}
                disabled={running || applying}
                onChange={(event) => setPendingMessage(event.target.value)}
                onBlur={() =>
                  void savePendingChanges({
                    repoId: repo.id,
                    changes: pending,
                    message: pendingMessage,
                    createdAt: Date.now(),
                  })
                }
                className="w-full resize-none rounded-md border border-ink-700 bg-ink-950 p-1.5 font-mono text-[11px] text-ink-200 outline-none focus:border-ink-600 disabled:opacity-60"
              />
            </label>
            {pending.map((change) => (
              <DiffView key={change.path} change={change} />
            ))}
            <p className="text-[10px] text-ink-400">
              Ao commitar, uma branch de backup da {repo.defaultBranch} e criada antes — da para
              voltar depois pelo historico, no topo do painel.
            </p>
          </div>
        )}
      </div>

      <div className="glass border-t border-ink-700 bg-ink-900 p-2">
        {!activeProvider && (
          <div className="mb-2 flex items-center justify-between rounded-md border border-ink-700 bg-ink-800 px-2 py-1.5 text-[11px] text-ink-400">
            Nenhuma IA conectada.
            <Button variant="ghost" onClick={onRequestSettings}>
              Conectar
            </Button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((anexo) => (
              <div
                key={anexo.id}
                className="group relative h-16 w-16 overflow-hidden rounded-md border border-ink-700"
                title={`${anexo.name} · ${Math.round(anexo.bytes / 1024)} KB`}
              >
                <img src={toPreviewUrl(anexo)} alt={anexo.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label={`Remover ${anexo.name}`}
                  onClick={() => remove(anexo.id)}
                  className="absolute right-0 top-0 bg-ink-950/80 px-1 text-[10px] text-ink-200 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {attachError && (
          <p className="mb-2 text-[10px] text-red-300">{attachError}</p>
        )}

        {attachments.length > 0 && describeVision(vision, activeProvider?.model ?? 'o modelo') && (
          <p
            className={`mb-2 text-[10px] ${
              vision === 'no' ? 'text-red-300' : 'text-lov-orange'
            }`}
          >
            {describeVision(vision, activeProvider?.model ?? 'o modelo')}
          </p>
        )}

        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onPaste={(event) => {
            // Colar uma captura de tela e' o caminho mais curto; se houve
            // imagem no clipboard, ela vira anexo em vez de texto.
            void addFromClipboard(event.clipboardData?.items ?? null).then((usou) => {
              if (usou) event.preventDefault();
            });
          }}
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

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={(event) => {
            void addFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="truncate font-mono text-[10px] text-ink-400">
            {activeProvider ? `${activeProvider.label} · ${activeProvider.model}` : 'sem IA'}
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              disabled={running}
              title="Anexar imagem (ou cole uma captura de tela)"
              onClick={() => fileRef.current?.click()}
            >
              Anexar
            </Button>
            <Button variant="ghost" onClick={() => void clearChat()} disabled={running}>
              Limpar
            </Button>
            {running ? (
              <Button
                variant="danger"
                onClick={() => {
                  setRetry(null);
                  abortRef.current?.abort();
                }}
              >
                Parar
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void send()}
                disabled={!input.trim() || blockedByVision}
                title={
                  blockedByVision
                    ? `${activeProvider?.model ?? 'O modelo'} nao le imagens`
                    : undefined
                }
              >
                Enviar
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
