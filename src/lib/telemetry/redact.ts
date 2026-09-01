import type { RepoId } from '../types';

/**
 * Redacao para publicacao. O repositorio de issues e' publico, entao nada que
 * identifique o trabalho do usuario pode sair daqui: nome de repositorio vira
 * hash, caminho de arquivo vira `<arquivo .ext>`, credencial vira placeholder.
 * O que sobra e' o suficiente para diagnosticar: tipo, mensagem e stack.
 */

const SECRET_PATTERNS: [RegExp, string][] = [
  [/github_pat_[A-Za-z0-9_]{20,}/g, '<token-github>'],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, '<token-github>'],
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, '<chave-anthropic>'],
  [/sk-[A-Za-z0-9_-]{20,}/g, '<chave-api>'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '<jwt>'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 <credencial>'],
  [/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, '<email>'],
];

/** Hash FNV-1a de 32 bits. Sincrono e estavel — serve para agrupar, nao para
 *  seguranca: identifica o mesmo repositorio entre relatorios sem revelar qual. */
export function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function hashRepoId(repoId: RepoId): string {
  return `repo#${shortHash(repoId)}`;
}

/** `src/components/Header.tsx` -> `<arquivo .tsx>` */
export function redactPath(path: string): string {
  const file = path.split('/').pop() ?? path;
  const dot = file.lastIndexOf('.');
  const ext = dot > 0 ? file.slice(dot) : '';
  return ext ? `<arquivo ${ext}>` : '<arquivo>';
}

/** Tira owner/name de URLs da API e query strings inteiras. */
export function redactUrl(url: string): string {
  return url
    .replace(/(api\.github\.com\/repos\/)[^/\s]+\/[^/\s?#]+/g, '$1<repo>')
    // O lookbehind evita que esta regra coma o `repos/` de api.github.com,
    // ja tratado pela linha acima.
    .replace(/(?<!api\.)(github\.com\/)[^/\s]+\/[^/\s?#]+/g, '$1<repo>')
    .replace(/\?[^\s"']*/g, '?<params>')
    .replace(/chrome-extension:\/\/[a-p]{32}/g, 'chrome-extension://<id>');
}

/**
 * Redige texto livre (mensagem de erro, stack). `knownRepoIds` cobre o caso em
 * que o nome do repositorio aparece no meio de uma frase, fora de uma URL.
 */
export function redactText(text: string, knownRepoIds: RepoId[] = []): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = redactUrl(out);
  for (const repoId of knownRepoIds) {
    // Escapa para tratar o repoId como literal dentro da regex.
    const escaped = repoId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), hashRepoId(repoId));
  }
  return out;
}

/** Mantem no maximo `maxFrames` quadros e limpa caminhos locais do bundle. */
export function redactStack(stack: string | undefined, knownRepoIds: RepoId[] = [], maxFrames = 20): string {
  if (!stack) return '(sem stack)';
  const lines = stack.split('\n').slice(0, maxFrames + 1);
  return redactText(lines.join('\n'), knownRepoIds);
}

/** Só o motor do navegador — a user agent completa é identificadora. */
export function browserSignature(userAgent: string): string {
  const match =
    /(Edg|OPR|Brave)\/(\d+)/.exec(userAgent) ??
    /(Chrome|Firefox|Safari)\/(\d+)/.exec(userAgent);
  return match ? `${match[1]} ${match[2]}` : 'desconhecido';
}
