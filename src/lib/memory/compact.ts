import type { MemoryEntry, MemoryKind } from './types';

/**
 * Tamanho de uma entrada pelo mesmo criterio que o Chrome usa para a cota do
 * `chrome.storage.local`: o comprimento da serializacao JSON.
 */
export function entrySize(entry: MemoryEntry): number {
  return JSON.stringify(entry).length;
}

export function totalSize(entries: MemoryEntry[]): number {
  return entries.reduce((soma, entrada) => soma + entrySize(entrada), 0);
}

const ROTULO: Record<MemoryKind, string> = {
  request: 'pedidos',
  decision: 'decisoes',
  action: 'alteracoes',
};

function dia(timestamp: number): string {
  const data = new Date(timestamp);
  const dd = String(data.getUTCDate()).padStart(2, '0');
  const mm = String(data.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

/** Nivel 0 -> 1: descarta o detalhe verbatim, preserva a linha de resumo. */
export function dropDetail(entry: MemoryEntry): MemoryEntry {
  if (entry.level !== 0) return entry;
  const { detail: _descartado, ...resto } = entry;
  return { ...resto, level: 1 };
}

/**
 * Funde entradas numa unica linha contada. Perde os textos individuais de
 * proposito: e' isso que faz a memoria caber. As entradas precisam ser do mesmo
 * repositorio e do mesmo tipo — fundir entre repositorios seria vazamento de
 * contexto, nao compressao.
 */
export function mergeEntries(entries: MemoryEntry[]): MemoryEntry {
  if (entries.length === 0) throw new Error('mergeEntries: nada a fundir');
  const repoIds = new Set(entries.map((entrada) => entrada.repoId));
  if (repoIds.size > 1) {
    throw new Error(
      `mergeEntries: entradas de repositorios diferentes (${[...repoIds].join(', ')})`,
    );
  }
  const kinds = new Set(entries.map((entrada) => entrada.kind));
  if (kinds.size > 1) {
    throw new Error(`mergeEntries: entradas de tipos diferentes (${[...kinds].join(', ')})`);
  }

  const ordenadas = [...entries].sort((a, b) => a.createdAt - b.createdAt);
  const primeira = ordenadas[0];
  const ultima = ordenadas[ordenadas.length - 1];
  const total = ordenadas.reduce((soma, entrada) => soma + (entrada.mergedCount ?? 1), 0);
  const inicio = primeira.createdAt;
  const fim = ultima.untilAt ?? ultima.createdAt;

  const caminhos = [...new Set(ordenadas.flatMap((entrada) => entrada.refs?.paths ?? []))];
  const mostrados = caminhos.slice(0, 6);
  const sufixoCaminhos =
    mostrados.length === 0
      ? ''
      : ` — ${mostrados.join(', ')}${
          caminhos.length > mostrados.length ? ` (+${caminhos.length - mostrados.length})` : ''
        }`;

  const periodo =
    dia(inicio) === dia(fim) ? `em ${dia(inicio)}` : `entre ${dia(inicio)} e ${dia(fim)}`;

  return {
    id: primeira.id,
    repoId: primeira.repoId,
    kind: primeira.kind,
    summary: `${total} ${ROTULO[primeira.kind]} ${periodo}${sufixoCaminhos}`,
    refs: mostrados.length > 0 ? { paths: mostrados } : undefined,
    createdAt: inicio,
    untilAt: fim,
    level: 2,
    mergedCount: total,
  };
}

/** Grupo candidato a fusao: mesmo repositorio, mesmo tipo, 2+ entradas. */
function grupoMaisAntigo(entries: MemoryEntry[]): MemoryEntry[] | null {
  const grupos = new Map<string, MemoryEntry[]>();
  for (const entrada of entries) {
    const chave = `${entrada.repoId} ${entrada.kind}`;
    const balde = grupos.get(chave);
    if (balde) balde.push(entrada);
    else grupos.set(chave, [entrada]);
  }

  let escolhido: MemoryEntry[] | null = null;
  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;
    // Comprime o passado distante primeiro: a memoria recente e' a que ainda
    // esta em uso, e perder resolucao nela e' o que atrapalharia.
    if (escolhido === null || grupo[0].createdAt < escolhido[0].createdAt) escolhido = grupo;
  }
  return escolhido;
}

/**
 * Traz o conjunto GLOBAL de entradas (todos os repositorios) para dentro do
 * orcamento, comprimindo do mais antigo para o mais recente. Nada e' apagado:
 * a linha do tempo continua inteira, com menos resolucao no passado.
 *
 * Funcao pura — o teto e o comportamento sao verificaveis sem tocar em storage.
 */
export function reclaim(entries: MemoryEntry[], budgetBytes: number): MemoryEntry[] {
  let atual = [...entries].sort((a, b) => a.createdAt - b.createdAt);
  if (totalSize(atual) <= budgetBytes) return atual;

  // 1) O detalhe verbatim e' o primeiro a sair, do mais antigo para o mais novo.
  for (let i = 0; i < atual.length && totalSize(atual) > budgetBytes; i++) {
    atual[i] = dropDetail(atual[i]);
  }

  // 2) Ainda apertado: funde as duas mais antigas do grupo mais antigo, ate
  //    sobrar uma linha por (repositorio, tipo).
  while (totalSize(atual) > budgetBytes) {
    const grupo = grupoMaisAntigo(atual);
    if (grupo === null) break;
    const fundir = grupo.slice(0, 2);
    const fundida = mergeEntries(fundir);
    const ids = new Set(fundir.map((entrada) => entrada.id));
    atual = [fundida, ...atual.filter((entrada) => !ids.has(entrada.id))].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  return atual;
}
