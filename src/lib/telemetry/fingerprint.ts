import { shortHash } from './redact';

/**
 * Normaliza a mensagem para que ocorrencias da mesma falha caiam no mesmo
 * fingerprint: numeros, hashes, ids e timestamps viram placeholders.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<data>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Primeiro quadro util da stack — o que muda entre defeitos diferentes. */
export function topFrame(stack: string): string {
  const line = stack
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('at ') && !entry.includes('captureError'));
  if (!line) return '';
  // Descarta coluna/linha: elas mudam a cada build e quebrariam o agrupamento.
  return line.replace(/:\d+:\d+\)?$/, '').slice(0, 200);
}

export function buildFingerprint(input: {
  origin: string;
  module: string;
  name: string;
  message: string;
  stack: string;
}): string {
  return shortHash(
    [
      input.origin,
      input.module,
      input.name,
      normalizeMessage(input.message),
      topFrame(input.stack),
    ].join('|'),
  );
}
