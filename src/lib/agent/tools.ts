import { getFileContent, GitHubError, searchCode } from '../github/client';
import { isReadablePath } from '../github/mapper';
import { applyChanges, normalizeRepoPath, type ApplyResult } from '../github/writer';
import { diffLines, diffStats } from '../diff';
import type { PendingFileChange, RepoMap, ToolCall, ToolResult } from '../types';
import type { ToolSchema } from '../ai/types';
import type { RepoScope } from './isolation';

const MAX_READ_BYTES = 200_000;

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'list_directory',
    description:
      'Lista arquivos e subdiretorios de um caminho do repositorio. Use "" ou "." para a raiz. ' +
      'Responde a partir do mapa ja carregado, sem custo de rede.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do diretorio, relativo a raiz. Vazio = raiz.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Le o conteudo completo de um arquivo do repositorio. Sempre leia um arquivo antes de reescreve-lo.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do arquivo relativo a raiz do repositorio.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_code',
    description:
      'Busca por texto no codigo do repositorio (busca do GitHub, restrita a este repositorio). ' +
      'Util para descobrir onde algo esta definido ou usado.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Termos de busca, ex.: "createUser" ou "supabase client".' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Cria ou substitui um arquivo. O campo content deve conter o arquivo INTEIRO e final, ' +
      'nunca um trecho ou diff. A alteracao fica pendente ate commit_changes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do arquivo relativo a raiz do repositorio.' },
        content: { type: 'string', description: 'Conteudo completo e final do arquivo.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_file',
    description: 'Marca um arquivo para remocao. A alteracao fica pendente ate commit_changes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do arquivo a remover.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'commit_changes',
    description:
      'Finaliza as alteracoes pendentes: cria a branch de backup e commita na branch padrao. ' +
      'Chame uma unica vez, quando todas as edicoes estiverem completas.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Mensagem de commit no imperativo. Primeira linha curta; detalhes depois.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
];

export interface ToolRuntime {
  scope: RepoScope;
  map: RepoMap;
  /** Commit/branch de leitura. Avanca apos cada commit aplicado. */
  ref: string;
  pending: Map<string, PendingFileChange>;
  autoApply: boolean;
  signal?: AbortSignal;
  onPendingChanged: () => void;
  onCommitted: (result: ApplyResult) => Promise<void>;
  /** Chamado quando ha alteracoes aguardando aprovacao manual do usuario. */
  onAwaitingApproval: (message: string) => void;
}

function ok(call: ToolCall, content: string): ToolResult {
  return { toolCallId: call.id, name: call.name, content };
}

function fail(call: ToolCall, content: string): ToolResult {
  return { toolCallId: call.id, name: call.name, content, isError: true };
}

function listDirectory(runtime: ToolRuntime, rawPath: string): string {
  const prefix = rawPath.replace(/^\.?\/*/, '').replace(/\/+$/, '');
  const scopePrefix = prefix === '' || prefix === '.' ? '' : `${prefix}/`;

  const children = new Map<string, 'blob' | 'tree'>();
  for (const entry of runtime.map.entries) {
    if (!entry.path.startsWith(scopePrefix)) continue;
    const rest = entry.path.slice(scopePrefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) children.set(rest, entry.type);
    else children.set(rest.slice(0, slash), 'tree');
  }

  if (children.size === 0) {
    return `Diretorio vazio ou inexistente: ${prefix || '(raiz)'}`;
  }
  return [...children.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, type]) => (type === 'tree' ? `${name}/` : name))
    .join('\n');
}

async function readFile(runtime: ToolRuntime, path: string): Promise<string> {
  const staged = runtime.pending.get(path);
  if (staged) {
    if (staged.action === 'delete') {
      return `(arquivo marcado para remocao nesta conversa — conteudo nao disponivel)`;
    }
    return `(versao pendente, ainda nao commitada)\n${staged.content ?? ''}`;
  }

  const entry = runtime.map.entries.find((e) => e.path === path && e.type === 'blob');
  if (entry?.size && entry.size > MAX_READ_BYTES) {
    return `Arquivo grande demais para ler inteiro (${entry.size} bytes). Use search_code para localizar o trecho relevante.`;
  }
  if (!isReadablePath(path)) {
    return `Arquivo binario ou ignorado: ${path}. Nao ha conteudo textual util.`;
  }

  const file = await getFileContent(runtime.scope.owner, runtime.scope.name, path, runtime.ref);
  return file.content;
}

export async function executeTool(runtime: ToolRuntime, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case 'list_directory':
        return ok(call, listDirectory(runtime, String(call.input.path ?? '')));

      case 'read_file': {
        const path = normalizeRepoPath(String(call.input.path ?? ''));
        return ok(call, await readFile(runtime, path));
      }

      case 'search_code': {
        const query = String(call.input.query ?? '').trim();
        if (!query) return fail(call, 'Informe um termo de busca.');
        const hits = await searchCode(runtime.scope.owner, runtime.scope.name, query);
        if (hits.length === 0) {
          const fromMap = runtime.map.entries
            .filter((e) => e.type === 'blob' && e.path.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 20)
            .map((e) => e.path);
          return ok(
            call,
            fromMap.length > 0
              ? `Sem resultados no conteudo. Arquivos cujo caminho casa com o termo:\n${fromMap.join('\n')}`
              : 'Nenhum resultado.',
          );
        }
        return ok(
          call,
          hits
            .map((hit) => `${hit.path}\n${hit.fragments.map((f) => `  | ${f}`).join('\n')}`)
            .join('\n\n'),
        );
      }

      case 'write_file': {
        const path = normalizeRepoPath(String(call.input.path ?? ''));
        const content = String(call.input.content ?? '');
        const existing = runtime.map.entries.find((e) => e.path === path && e.type === 'blob');

        let previousContent: string | null = runtime.pending.get(path)?.content ?? null;
        if (previousContent === null && existing) {
          try {
            const file = await getFileContent(
              runtime.scope.owner,
              runtime.scope.name,
              path,
              runtime.ref,
            );
            previousContent = file.content;
          } catch {
            previousContent = null;
          }
        }

        const change: PendingFileChange = {
          path,
          content,
          previousContent,
          action: existing ? 'update' : 'create',
        };
        runtime.pending.set(path, change);
        runtime.onPendingChanged();

        const stats = diffStats(diffLines(previousContent ?? '', content));
        return ok(
          call,
          `${change.action === 'create' ? 'Criado' : 'Atualizado'} (pendente): ${path} (+${stats.added}/-${stats.removed})`,
        );
      }

      case 'delete_file': {
        const path = normalizeRepoPath(String(call.input.path ?? ''));
        const existing = runtime.map.entries.find((e) => e.path === path && e.type === 'blob');
        if (!existing) return fail(call, `Arquivo nao existe no repositorio: ${path}`);
        let previousContent: string | null = null;
        try {
          const file = await getFileContent(runtime.scope.owner, runtime.scope.name, path, runtime.ref);
          previousContent = file.content;
        } catch {
          previousContent = null;
        }
        runtime.pending.set(path, { path, content: null, previousContent, action: 'delete' });
        runtime.onPendingChanged();
        return ok(call, `Marcado para remocao (pendente): ${path}`);
      }

      case 'commit_changes': {
        const message = String(call.input.message ?? '').trim();
        if (!message) return fail(call, 'A mensagem de commit e obrigatoria.');
        const changes = [...runtime.pending.values()];
        if (changes.length === 0) {
          return fail(call, 'Nao ha alteracoes pendentes para commitar.');
        }
        if (!runtime.autoApply) {
          runtime.onAwaitingApproval(message);
          return ok(
            call,
            `${changes.length} alteracao(oes) prontas e aguardando aprovacao manual do usuario na interface. ` +
              'Explique o que foi feito e encerre o turno; nao chame commit_changes de novo.',
          );
        }
        const result = await applyChanges(
          runtime.scope.repo,
          runtime.scope.defaultBranch,
          changes,
          message,
        );
        await runtime.onCommitted(result);
        return ok(
          call,
          [
            `Commit aplicado em ${runtime.scope.defaultBranch}: ${result.checkpoint.commitSha.slice(0, 7)}`,
            `Backup criado antes do commit: ${result.checkpoint.backupBranch}`,
            `Arquivos: ${changes.map((c) => `${c.action[0].toUpperCase()} ${c.path}`).join(', ')}`,
          ].join('\n'),
        );
      }

      default:
        return fail(call, `Tool desconhecida: ${call.name}`);
    }
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      return fail(call, `Nao encontrado no repositorio: ${error.message}`);
    }
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}
