import { getFileContent, GitHubError, searchCode } from '../github/client';
import { isReadablePath } from '../github/mapper';
import { applyChanges, normalizeRepoPath, type ApplyResult } from '../github/writer';
import { diffLines, diffStats } from '../diff';
import { callMcpTool, mcpToolSchemas } from '../mcp/registry';
import { parseNamespacedToolName } from '../mcp/protocol';
import type { McpServerConfig } from '../mcp/types';
import type { PendingFileChange, RepoMap, ToolCall, ToolResult, TreeEntry } from '../types';
import type { ToolSchema } from '../ai/types';
import { ContextIsolationError, type RepoScope } from './isolation';

const MAX_READ_BYTES = 200_000;

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'remember',
    description:
      'Grava um fato duradouro na memoria DESTE repositorio. Chame por conta propria, ' +
      'sem esperar o usuario pedir "guarde isso": o gatilho e o usuario definir COMO as ' +
      'coisas funcionam aqui — uma convencao ("sempre use X"), uma proibicao ("nunca ' +
      'mexa em Y"), um padrao de nomenclatura, uma preferencia de estilo, uma decisao de ' +
      'arquitetura, algo que ele recusou. Grave na mesma resposta em que ele disser. ' +
      'Fora disso, parcimonia: nao registre a tarefa do dia ("ajuste o header agora"), ' +
      'nem o que ja esta no codigo (isso se le com read_file), nem o passo a passo do que ' +
      'voce acabou de fazer (commits ja entram na memoria sozinhos).',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Uma linha, no maximo 280 caracteres. O fato em si.',
        },
        detail: {
          type: 'string',
          description: 'Contexto opcional: por que ficou assim. Some primeiro quando a memoria aperta.',
        },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
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

/**
 * Junta as tools nativas do agente com as dos servidores MCP habilitados para
 * ESTE repositorio. Servidor nao habilitado simplesmente nao existe no prompt.
 */
export function buildToolSchemas(mcpServers: McpServerConfig[]): ToolSchema[] {
  return [...TOOL_SCHEMAS, ...mcpToolSchemas(mcpServers)];
}

/**
 * Indice `caminho -> entrada` da arvore, construido uma vez por turno.
 *
 * Antes, cada `read_file`/`write_file`/`delete_file` varria `map.entries`
 * inteiro procurando um caminho. Num repositorio com milhares de arquivos e ate
 * 16 passos por turno, era a mesma pergunta ("qual entrada tem este caminho?")
 * respondida do zero toda vez. A relacao e' chave/valor; a estrutura passa a
 * ser a que representa isso.
 */
export function indexBlobsByPath(map: RepoMap): Map<string, TreeEntry> {
  const porCaminho = new Map<string, TreeEntry>();
  for (const entry of map.entries) {
    if (entry.type === 'blob') porCaminho.set(entry.path, entry);
  }
  return porCaminho;
}

export interface ToolRuntime {
  scope: RepoScope;
  map: RepoMap;
  /** Indice da arvore por caminho. Ver `indexBlobsByPath`. */
  blobsByPath: Map<string, TreeEntry>;
  /** Ja filtrados por repositorio antes de chegar aqui. */
  mcpServers: McpServerConfig[];
  /** Commit/branch de leitura. Avanca apos cada commit aplicado. */
  ref: string;
  pending: Map<string, PendingFileChange>;
  autoApply: boolean;
  signal?: AbortSignal;
  onPendingChanged: () => void;
  onCommitted: (result: ApplyResult) => Promise<void>;
  /** Chamado quando ha alteracoes aguardando aprovacao manual do usuario. */
  onAwaitingApproval: (message: string) => void;
  /** Fato que o modelo quer guardar na memoria deste repositorio. */
  onRemember: (summary: string, detail?: string) => void;
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

  const entry = runtime.blobsByPath.get(path);
  if (entry?.size && entry.size > MAX_READ_BYTES) {
    return `Arquivo grande demais para ler inteiro (${entry.size} bytes). Use search_code para localizar o trecho relevante.`;
  }
  if (!isReadablePath(path)) {
    return `Arquivo binario ou ignorado: ${path}. Nao ha conteudo textual util.`;
  }

  const file = await getFileContent(runtime.scope.owner, runtime.scope.name, path, runtime.ref);
  return file.content;
}

async function executeMcpTool(runtime: ToolRuntime, call: ToolCall): Promise<ToolResult> {
  const parsed = parseNamespacedToolName(call.name);
  if (!parsed) return fail(call, `Nome de tool MCP invalido: ${call.name}`);

  const server = runtime.mcpServers.find((candidate) => candidate.id === parsed.serverId);
  if (!server) {
    return fail(
      call,
      `O servidor MCP dessa ferramenta nao esta habilitado para ${runtime.scope.repoId}.`,
    );
  }
  // Defesa em profundidade: a lista ja vem filtrada, mas um servidor que
  // escapasse do filtro seria um furo de isolamento, nao um erro de tool.
  if (!server.enabledRepoIds.includes(runtime.scope.repoId)) {
    throw new ContextIsolationError(
      `Servidor MCP ${server.label} nao esta habilitado para ${runtime.scope.repoId}.`,
      'scope-mismatch',
    );
  }

  const result = await callMcpTool(server, parsed.toolName, call.input, runtime.signal);
  return {
    toolCallId: call.id,
    name: call.name,
    content: result.content,
    isError: result.isError,
  };
}

export async function executeTool(runtime: ToolRuntime, call: ToolCall): Promise<ToolResult> {
  try {
    if (call.name.startsWith('mcp__')) return await executeMcpTool(runtime, call);

    switch (call.name) {
      case 'remember': {
        const summary = String(call.input.summary ?? '').trim();
        if (summary === '') return fail(call, 'remember exige um `summary` nao vazio.');
        const detail = call.input.detail === undefined ? undefined : String(call.input.detail);
        runtime.onRemember(summary, detail);
        return ok(call, 'Registrado na memoria deste repositorio.');
      }

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
        const existing = runtime.blobsByPath.get(path);

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
        const existing = runtime.blobsByPath.get(path);
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
    // Falha de isolamento nunca vira "erro de tool": ela precisa subir para o
    // modulo de erros como defeito de alta prioridade.
    if (error instanceof ContextIsolationError) throw error;
    if (error instanceof GitHubError && error.status === 404) {
      return fail(call, `Nao encontrado no repositorio: ${error.message}`);
    }
    return fail(call, error instanceof Error ? error.message : String(error));
  }
}
