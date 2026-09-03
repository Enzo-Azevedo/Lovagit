import type { ToolResult } from '../lib/types';

export const TOOL_LABEL: Record<string, string> = {
  list_directory: 'listou',
  read_file: 'leu',
  search_code: 'buscou',
  write_file: 'escreveu',
  delete_file: 'removeu',
  commit_changes: 'commitou',
  remember: 'anotou',
};

/**
 * Teto do conteudo mostrado ao expandir uma acao. Um `read_file` pode trazer
 * 200 KB, e jogar isso no DOM trava o painel — que e' estreito e ja carrega a
 * conversa inteira montada.
 */
export const MAX_RESULT_CHARS = 20_000;

/** O que a acao mirou: caminho, consulta, ou o proprio texto anotado. */
export function targetOfCall(input: Record<string, unknown>): string {
  const alvo = input.path ?? input.query ?? input.summary ?? '';
  return typeof alvo === 'string' ? alvo : JSON.stringify(alvo);
}

/** Conteudo do resultado, cortado no teto de exibicao. */
export function visibleResult(result: ToolResult | undefined): string {
  if (!result) return 'Sem resultado — a acao nao chegou a terminar.';
  if (result.content.length <= MAX_RESULT_CHARS) return result.content;
  const restante = result.content.length - MAX_RESULT_CHARS;
  return `${result.content.slice(0, MAX_RESULT_CHARS)}\n\n... (${restante} caracteres a mais nao exibidos)`;
}
