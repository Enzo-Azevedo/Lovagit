import { fingerprintMarker } from './issues';
import { LABELS, type ErrorReport } from './types';

/** Erro da extensao entra como alta prioridade; integracao entra como normal. */
export function labelsFor(report: ErrorReport): string[] {
  return report.origin === 'extension'
    ? [LABELS.highPriority, LABELS.extensionError]
    : [LABELS.integrationError];
}

/**
 * Resumo legivel para o titulo do issue.
 *
 * Duas armadilhas, as duas vistas no #17. A primeira: o GitHub engole marcacao
 * em angulo no titulo, entao `respondeu <n>:` chega la como `respondeu :` — e a
 * redacao e o fingerprint produzem exatamente esse tipo de placeholder
 * (`<n>`, `<sha>`, `<arquivo .ts>`). Viram parenteses antes de sair. A segunda:
 * cortar no caractere 90 seco parte a mensagem no meio de uma palavra sem aviso
 * nenhum de que havia mais texto.
 *
 * O titulo nao normaliza numeros como o fingerprint faz: agrupar ocorrencias e'
 * trabalho do marcador no corpo, e no titulo o status HTTP e' o que se le
 * primeiro na lista de issues.
 */
export function titleSummary(message: string, limit = 90): string {
  const flat = message
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/</g, '(')
    .replace(/>/g, ')');
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1).trimEnd()}…`;
}

export function buildIssueTitle(report: ErrorReport): string {
  const prefix = report.origin === 'extension' ? '[extensao]' : '[integracao]';
  return `${prefix} ${report.name} em ${report.context.module ?? 'desconhecido'}: ${titleSummary(report.message)}`;
}

function table(rows: [string, string][]): string {
  return ['| Campo | Valor |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

export function buildIssueBody(report: ErrorReport, reason: string): string {
  const contextRows = Object.entries(report.context)
    .filter(([, value]) => value !== '')
    .map(([key, value]): [string, string] => [key, `\`${value}\``]);

  return [
    `<!-- ${fingerprintMarker(report.fingerprint)} -->`,
    'Relatorio automatico do modulo de deteccao de erros do Lovagit.',
    '',
    table([
      ['Prioridade', report.origin === 'extension' ? '**Alta**' : 'Normal'],
      ['Origem', report.origin === 'extension' ? 'Codigo da extensao' : 'Servico externo'],
      ['Classe', `\`${report.name}\``],
      ...(report.status ? ([['HTTP', String(report.status)]] as [string, string][]) : []),
      ['Versao da extensao', report.extensionVersion],
      ['Navegador', report.browser],
      ['Primeira ocorrencia', new Date(report.createdAt).toISOString()],
      ['Ocorrencias ate o envio', String(report.occurrences)],
      ['Fingerprint', `\`${report.fingerprint}\``],
    ]),
    '',
    '### Classificacao',
    reason,
    '',
    '### Mensagem',
    '```',
    report.message,
    '```',
    '',
    '### Stack',
    '```',
    report.stack,
    '```',
    ...(contextRows.length > 0 ? ['', '### Contexto', table(contextRows)] : []),
    '',
    '---',
    '<sub>Conteudo redigido na origem: nome de repositorio vira hash estavel, caminho de arquivo vira ' +
      '`<arquivo .ext>`, credenciais, e-mails e identificadores de conta sao mascarados. ' +
      'Nenhum prompt ou trecho de codigo e enviado.</sub>',
  ].join('\n');
}

export function buildRecurrenceComment(report: ErrorReport): string {
  return [
    `<!-- ${fingerprintMarker(report.fingerprint)} -->`,
    `A mesma falha voltou a acontecer: **${report.occurrences} ocorrencia(s)** desde o ultimo relatorio.`,
    '',
    table([
      ['Ultima ocorrencia', new Date(report.createdAt).toISOString()],
      ['Versao da extensao', report.extensionVersion],
      ['Navegador', report.browser],
      ...(report.status ? ([['HTTP', String(report.status)]] as [string, string][]) : []),
    ]),
    '',
    '```',
    report.message,
    '```',
  ].join('\n');
}
