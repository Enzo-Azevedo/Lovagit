/** Identificador canonico de um repositorio: "owner/name". Toda a extensao usa
 *  esse formato como chave de isolamento — nunca o id numerico do GitHub. */
export type RepoId = string;

/** Imagem anexada a uma mensagem do chat. Persistida na conversa como base64. */
export interface ChatAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface RepoRef {
  id: RepoId;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
}

export interface RepoMap {
  repoId: RepoId;
  defaultBranch: string;
  headSha: string;
  generatedAt: number;
  /** Entradas do git tree (recursivo). Pode vir truncado em repos gigantes. */
  entries: TreeEntry[];
  truncated: boolean;
  languages: Record<string, number>;
  /** Frameworks/ferramentas detectados a partir de arquivos-manifesto. */
  stack: string[];
  entryPoints: string[];
  /** Trechos de arquivos-chave (README, package.json...) ja lidos no mapeamento. */
  highlights: { path: string; excerpt: string }[];
  fileCount: number;
  dirCount: number;
}

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  /** Sempre presente: o firewall de contexto rejeita mensagens de outro repo. */
  repoId: RepoId;
  role: ChatRole;
  content: string;
  attachments?: ChatAttachment[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  createdAt: number;
  /** Erro de execucao exibido na UI, nao enviado ao modelo. */
  error?: string;
}

export interface PendingFileChange {
  path: string;
  /** `null` = arquivo removido. */
  content: string | null;
  previousContent: string | null;
  action: 'create' | 'update' | 'delete';
}

export interface Checkpoint {
  id: string;
  repoId: RepoId;
  /** Branch criada a partir da main ANTES do commit — o backup. */
  backupBranch: string;
  /** SHA da main antes da alteracao (o que a branch de backup aponta). */
  baseSha: string;
  /** SHA do commit aplicado na main. */
  commitSha: string;
  branch: string;
  message: string;
  files: { path: string; action: PendingFileChange['action'] }[];
  createdAt: number;
  restoredAt?: number;
  /** Checkpoint gerado por uma restauracao aponta para o checkpoint de origem. */
  restoredFrom?: string;
}

export type ProviderKind = 'anthropic' | 'openai-compatible';

export interface BaseProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  model: string;
  maxTokens: number;
  temperature?: number;
}

export interface AnthropicProviderConfig extends BaseProviderConfig {
  kind: 'anthropic';
  baseUrl: string;
}

export interface OpenAICompatibleProviderConfig extends BaseProviderConfig {
  kind: 'openai-compatible';
  baseUrl: string;
}

export type ProviderConfig = AnthropicProviderConfig | OpenAICompatibleProviderConfig;

export interface Settings {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  connectedRepoIds: RepoId[];
  /** Politica de escrita: sempre cria backup antes de commitar na branch alvo. */
  autoApplyChanges: boolean;
  githubUser?: { login: string; avatarUrl: string } | null;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: number;
}
