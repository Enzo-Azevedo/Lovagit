import { getMemoryEntries, getSettings, memoryKey, saveMemoryEntries } from '../storage';
import type { RepoId } from '../types';
import { entrySize, reclaim, totalSize } from './compact';
import type { MemoryEntry, MemoryKind, MemoryUsage } from './types';

/** Padrao pedido: 1 GiB para o conjunto de TODOS os repositorios. */
export const DEFAULT_MEMORY_BUDGET_BYTES = 1_073_741_824;

/** Abaixo disso nao sobra memoria util depois da compressao. */
export const MIN_MEMORY_BUDGET_BYTES = 64 * 1024;

/**
 * Sem `unlimitedStorage`, a cota do `chrome.storage.local` e' 10 MB para TUDO
 * que a extensao guarda — mapa do repositorio, chat, checkpoints. A memoria
 * fica com uma fatia disso; passar de la faria a gravacao falhar e derrubar
 * coisas que nao tem nada a ver com memoria.
 */
export const BUDGET_SEM_PERMISSAO_BYTES = 4 * 1024 * 1024;

/**
 * `unlimitedStorage` esta entre as permissoes que o Chrome NAO aceita como
 * opcionais: ela e' concedida na instalacao ou nao existe. Pedi-la em runtime
 * com `chrome.permissions.request` falha sempre — era por isso que o botao das
 * configuracoes nao fazia nada.
 *
 * Por isso ela vive em `permissions` no manifest. Esta funcao continua existindo
 * porque uma instalacao antiga so passa a ter a permissao depois de recarregar
 * a extensao, e ate la o orcamento precisa se limitar sozinho.
 */
export async function hasUnlimitedStorage(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['unlimitedStorage'] });
  } catch (caught) {
    // Sem a resposta do Chrome, assumir o teto menor e' o lado seguro do erro:
    // estourar a cota derrubaria gravacoes que nao tem a ver com memoria.
    console.warn('Nao foi possivel conferir a permissao de armazenamento', caught);
    return false;
  }
}

/**
 * Orcamento que vale de verdade: o configurado, limitado pela cota real quando
 * a permissao de armazenamento ilimitado nao foi concedida.
 */
export async function effectiveBudgetBytes(): Promise<number> {
  const settings = await getSettings();
  const desejado = Math.max(MIN_MEMORY_BUDGET_BYTES, settings.memoryBudgetBytes);
  return (await hasUnlimitedStorage()) ? desejado : Math.min(desejado, BUDGET_SEM_PERMISSAO_BYTES);
}

/**
 * Gravações em serie. Um turno pode emitir dois fatos quase juntos (um commit e
 * o pedido que o gerou); como cada gravação e' ler-modificar-escrever, duas em
 * paralelo perderiam uma das entradas em silencio.
 */
let fila: Promise<unknown> = Promise.resolve();
function emSerie<T>(tarefa: () => Promise<T>): Promise<T> {
  const proxima = fila.then(tarefa, tarefa);
  fila = proxima.catch(() => undefined);
  return proxima;
}

/**
 * Bytes ocupados pela memoria, SEM carregar o conteudo. Importa porque a
 * verificacao de orcamento roda a cada fato gravado: carregar tudo so para
 * medir o tamanho seria pagar o preco do teto inteiro em toda escrita.
 */
async function bytesEmUso(repoIds: RepoId[]): Promise<number | null> {
  const getBytesInUse = chrome.storage.local.getBytesInUse?.bind(chrome.storage.local);
  if (!getBytesInUse) return null;
  try {
    return await getBytesInUse(repoIds.map(memoryKey));
  } catch {
    return null;
  }
}

let contador = 0;
function novoId(): string {
  contador += 1;
  return `mem_${Date.now().toString(36)}_${contador}`;
}

export interface NewMemoryEntry {
  repoId: RepoId;
  kind: MemoryKind;
  summary: string;
  detail?: string;
  refs?: { paths?: string[]; commitSha?: string };
}

/** Corta um texto longo antes de virar memoria: aqui se guarda fato, nao transcricao. */
export function trimForMemory(text: string, maxChars = 280): string {
  const limpo = text.replace(/\s+/g, ' ').trim();
  return limpo.length <= maxChars ? limpo : `${limpo.slice(0, maxChars - 1)}…`;
}

export async function loadMemory(repoId: RepoId): Promise<MemoryEntry[]> {
  const entradas = await getMemoryEntries(repoId);
  return entradas.sort((a, b) => a.createdAt - b.createdAt);
}

export async function recordMemory(nova: NewMemoryEntry): Promise<MemoryEntry> {
  const entrada: MemoryEntry = {
    id: novoId(),
    repoId: nova.repoId,
    kind: nova.kind,
    summary: trimForMemory(nova.summary),
    detail: nova.detail ? trimForMemory(nova.detail, 2000) : undefined,
    refs: nova.refs,
    createdAt: Date.now(),
    level: 0,
  };

  return emSerie(async () => {
    const atuais = await getMemoryEntries(nova.repoId);
    await saveMemoryEntries(nova.repoId, [...atuais, entrada]);
    await aplicarOrcamento();
    return entrada;
  });
}

export async function forgetMemoryEntry(repoId: RepoId, id: string): Promise<MemoryEntry[]> {
  return emSerie(async () => {
    const atuais = await getMemoryEntries(repoId);
    const restantes = atuais.filter((entrada) => entrada.id !== id);
    await saveMemoryEntries(repoId, restantes);
    return restantes;
  });
}

export async function clearRepoMemory(repoId: RepoId): Promise<void> {
  await emSerie(() => saveMemoryEntries(repoId, []));
}

async function carregarTudo(): Promise<Map<RepoId, MemoryEntry[]>> {
  const settings = await getSettings();
  // Uma leitura por repositorio, e elas nao dependem umas das outras: em serie,
  // o custo era a soma; em paralelo, o do repositorio mais lento.
  const carregadas = await Promise.all(
    settings.connectedRepoIds.map(
      async (repoId) => [repoId, await getMemoryEntries(repoId)] as const,
    ),
  );
  return new Map(carregadas);
}

/**
 * O orcamento e' do conjunto, nao de cada repositorio: um projeto em uso
 * intenso pode ocupar quase tudo, e a pressao so aparece quando outro projeto
 * comeca a gravar. Nesse momento o que comprime e' o mais antigo — de qualquer
 * repositorio — e nao necessariamente o do projeto que acabou de escrever.
 */
export async function enforceGlobalBudget(): Promise<void> {
  return emSerie(aplicarOrcamento);
}

async function aplicarOrcamento(): Promise<void> {
  const budget = await effectiveBudgetBytes();
  const settings = await getSettings();

  // Caminho rapido: mede sem carregar. So quando estoura vale a pena ler tudo.
  const medido = await bytesEmUso(settings.connectedRepoIds);
  if (medido !== null && medido <= budget) return;

  const porRepo = await carregarTudo();
  const todas = [...porRepo.values()].flat();
  if (totalSize(todas) <= budget) return;

  const reclamadas = reclaim(todas, budget);
  const novoPorRepo = new Map<RepoId, MemoryEntry[]>();
  for (const repoId of porRepo.keys()) novoPorRepo.set(repoId, []);
  for (const entrada of reclamadas) {
    const balde = novoPorRepo.get(entrada.repoId);
    if (balde) balde.push(entrada);
  }

  for (const [repoId, entradas] of novoPorRepo) {
    const antes = porRepo.get(repoId) ?? [];
    if (JSON.stringify(antes) === JSON.stringify(entradas)) continue;
    await saveMemoryEntries(repoId, entradas);
  }
}

export async function memoryUsage(): Promise<MemoryUsage> {
  const budgetBytes = await effectiveBudgetBytes();
  const porRepo = await carregarTudo();
  const byRepo = [...porRepo.entries()]
    .map(([repoId, entradas]) => ({
      repoId,
      bytes: entradas.reduce((soma, entrada) => soma + entrySize(entrada), 0),
      entries: entradas.length,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    bytes: byRepo.reduce((soma, item) => soma + item.bytes, 0),
    budgetBytes,
    entries: byRepo.reduce((soma, item) => soma + item.entries, 0),
    byRepo,
  };
}
