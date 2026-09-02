import { fingerprintMarker } from './issues';
import { normalizeMessage } from './fingerprint';
import { LABELS, type ErrorReport } from './types';

/** Erro da extensao entra como alta prioridade; integracao entra como normal. */
export function labelsFor(report: ErrorReport): string[] {
  return report.origin === 'extension'
    ? [LABELS.highPriority, LABELS.extensionError]
    : [LABELS.integrationError];
}

export function buildIssueTitle(report: ErrorReport): string {
  const summary = normalizeMessage(report.message).slice(0, 90);
  const prefix = report.origin === 'extension' ? '[extensao]' : '[integracao]';
  return `${prefix} ${report.name} em ${report.context.module ?? 'desconhecido'}: ${summary}`;
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
      '`<arquivo .ext>`, credenciais e e-mails sao mascarados. Nenhum prompt ou trecho de codigo e enviado.</sub>',
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
