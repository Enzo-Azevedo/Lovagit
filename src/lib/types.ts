/** Identificador canonico de um repositorio: "owner/name". Toda a extensao usa
 *  esse formato como chave de isolamento — nunca o id numerico do GitHub. */
export type RepoId = string;

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

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

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

/**
 * Imagem anexada, do jeito que vai para o modelo: base64 cru mais o tipo.
 *
 * Vive apenas no turno em que foi anexada. Nada disso e' persistido — uma
 * captura de tela vira centenas de KB em base64, e a cota do
 * `chrome.storage.local` e' de 10 MB para tudo que a extensao guarda.
 */
export interface TurnImage {
  mediaType: string;
  /** Base64 SEM o prefixo `data:` — o Anthropic quer cru, o OpenAI quer URL. */
  dataBase64: string;
}

/**
 * O que sobra de um anexo no historico: o registro de que ele existiu. O
 * conteudo em si e' descartado depois do turno.
 */
export interface AttachmentRef {
  name: string;
  mediaType: string;
  bytes: number;
}

export interface ChatMessage {
  id: string;
  /** Sempre presente: o firewall de contexto rejeita mensagens de outro repo. */
  repoId: RepoId;
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  /**
   * Raciocinio DESTE passo. Fica na mensagem, e nao num painel a parte, para a
   * leitura ser cronologica: o que ela pensou antes desta acao, e nao o que
   * pensou no inicio do turno. Nunca e reenviado ao modelo.
   */
  reasoning?: string;
  /** Imagens que acompanharam esta mensagem — so o registro, sem o conteudo. */
  attachments?: AttachmentRef[];
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

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'oauth';

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

/** Login via OAuth 2.0 + PKCE em um provedor terceiro. O access token obtido e'
 *  usado como Bearer contra um endpoint no formato OpenAI (chat/completions). */
export interface OAuthProviderConfig extends BaseProviderConfig {
  kind: 'oauth';
  baseUrl: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Alguns provedores exigem `audience`/params extras no authorize. */
  extraAuthParams?: Record<string, string>;
}

export type ProviderConfig =
  | AnthropicProviderConfig
  | OpenAICompatibleProviderConfig
  | OAuthProviderConfig;

export interface Settings {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  connectedRepoIds: RepoId[];
  /** Politica de escrita: sempre cria backup antes de commitar na branch alvo. */
  autoApplyChanges: boolean;
  /**
   * Reenvia a mensagem sozinho, uma unica vez, quando o turno cai por falha
   * passageira do provedor. Desligado por padrao: reenviar gasta tokens e nem
   * toda falha melhora na segunda tentativa.
   */
  autoRetryOnFailure: boolean;
  /**
   * Teto da memoria somando TODOS os repositorios. Um projeto sozinho pode
   * ocupar quase tudo; a compressao so entra quando o conjunto passa daqui.
   */
  memoryBudgetBytes: number;
  githubUser?: { login: string; avatarUrl: string } | null;
  /**
   * `unlimitedStorage` precisa de gesto do usuario para ser concedida; o pedido
   * so pode ser feito de novo se o usuario agir. Este campo marca que a pergunta
   * ja foi exibida uma vez no side panel — sem ele, o aviso apareceria em toda
   * abertura ate o fim dos tempos.
   */
  unlimitedStorageAsked?: boolean;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: number;
}
