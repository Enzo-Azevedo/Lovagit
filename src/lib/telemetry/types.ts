import type { RepoId } from '../types';

/** De onde o erro veio — decide a prioridade do issue. */
export type ErrorOrigin =
  /** Defeito no codigo da propria extensao. Prioridade alta por padrao. */
  | 'extension'
  /** Servico externo respondeu de forma inesperada (GitHub, provedor de IA). */
  | 'integration';

/** O que o erro e' — decide se vira issue ou fica so na interface. */
export type ErrorCategory =
  /** Defeito: vira issue. */
  | 'bug'
  /** Configuracao do usuario (chave errada, PAT sem permissao): so na UI. */
  | 'user-config'
  /** Falha passageira (offline, rate limit, 5xx): so na UI. */
  | 'transient'
  /** Cancelamento do usuario: ignorado por completo. */
  | 'ignored';

export interface ErrorContext {
  /** Modulo onde o erro apareceu, ex.: 'agent/loop', 'github/writer'. */
  module: string;
  /** Repositorio envolvido — vira hash no relatorio, nunca o nome. */
  repoId?: RepoId;
  /** Caminho de arquivo do repositorio — vira `<arquivo .ext>` no relatorio. */
  path?: string;
  /** Tool do agente em execucao. */
  tool?: string;
  /** Tipo do provedor de IA ativo (nunca a chave, nunca a URL completa). */
  providerKind?: string;
  /** Passo do fluxo, ex.: 'mapeamento', 'commit', 'restauracao'. */
  step?: string;
}

export interface ErrorReport {
  id: string;
  /** Hash estavel do erro: mesma falha => mesmo fingerprint => mesmo issue. */
  fingerprint: string;
  origin: ErrorOrigin;
  category: ErrorCategory;
  /** Nome da classe do erro, ex.: 'GitHubError', 'TypeError'. */
  name: string;
  /** Mensagem ja redigida. */
  message: string;
  /** Stack ja redigida, no maximo 20 quadros. */
  stack: string;
  /** Contexto ja redigido, pronto para publicacao. */
  context: Record<string, string>;
  /** Status HTTP, quando o erro veio de uma resposta. */
  status?: number;
  extensionVersion: string;
  /** Apenas o motor do navegador, sem a user agent string completa. */
  browser: string;
  createdAt: number;
  occurrences: number;
}

export interface ReportOutcome {
  report: ErrorReport;
  /** Numero do issue aberto ou comentado. */
  issueNumber?: number;
  issueUrl?: string;
  /** True quando comentou em um issue existente em vez de abrir outro. */
  deduplicated: boolean;
  /** Preenchido quando o proprio envio falhou (fica so no log local). */
  deliveryError?: string;
  /** Labels que o GitHub aceitou. Vazio quando o token nao tem push access. */
  appliedLabels: string[];
}

export interface TelemetrySettings {
  enabled: boolean;
  /** Repositorio destino dos issues, no formato owner/name. */
  /** Segundos de janela para cancelar o envio. */
  undoSeconds: number;
  /** Teto de issues novos abertos por hora. */
  maxIssuesPerHour: number;
}

/**
 * Destino fixo dos issues: o repositorio da propria extensao.
 *
 * E' uma constante, e nao uma configuracao, porque nao existe caso legitimo de
 * apontar o relato de defeito da extensao para outro lugar. Como campo editavel
 * ele so oferecia formas de quebrar: um repositorio onde o PAT nao tem
 * `Issues: write` faz todo relato falhar, e um repositorio de terceiro receberia
 * stack traces e caminhos de arquivo de quem usa a extensao.
 */
export const ISSUE_TARGET_REPO: RepoId = 'Enzo-Azevedo/Lovagit';

export const DEFAULT_TELEMETRY: TelemetrySettings = {
  enabled: true,
  undoSeconds: 10,
  maxIssuesPerHour: 5,
};

export const LABELS = {
  highPriority: 'Alta Prioridade',
  extensionError: 'lovagit:erro-extensao',
  integrationError: 'lovagit:erro-integracao',
} as const;
