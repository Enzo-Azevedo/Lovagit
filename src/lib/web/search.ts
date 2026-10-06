/**
 * Busca na web para o agente.
 *
 * Duas fontes, ambas gratuitas e sem chave nem conta:
 *
 * 1. Resposta instantanea (`api.duckduckgo.com`): o Abstract/Answer e os
 *    topicos relacionados. Boa para "o que e' X", "qual a sintaxe de Y".
 *
 * 2. Resultados organicos (`html.duckduckgo.com/html`): titulo, trecho e link
 *    de cada resultado de busca. A resposta instantanea sozinha voltava vazia
 *    para pergunta tecnica — "qual o input `build-scan-terms-of-use-agree` da
 *    action setup-gradle?" nao tem pagina de enciclopedia, mas tem milhares de
 *    paginas na web.
 *
 * Nenhuma das duas e' uma varredura completa da web: pergunta muito recente ou
 * obscura ainda pode voltar vazia, e o agente e' avisado disso.
 */

const INSTANT_ENDPOINT = 'https://api.duckduckgo.com/';
const RESULTS_ENDPOINT = 'https://html.duckduckgo.com/html/';

/**
 * Hosts que a busca alcanca. Precisam de permissao de host: sem ela, o fetch
 * sai de uma pagina de extensao como requisicao cross-origin comum e o
 * navegador barra ANTES de a rede ser usada — o sintoma vira "problema de
 * rede", nunca "sem resultado". O `duckduckgo.com` entra porque o endpoint
 * HTML pode redirecionar para a raiz do dominio.
 */
const WEB_SEARCH_ORIGINS = ['https://duckduckgo.com/*', 'https://*.duckduckgo.com/*'];

/** Consulta se a permissao de host ja foi concedida. Nao pede nada. */
export async function hasWebSearchPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: WEB_SEARCH_ORIGINS });
}

/**
 * Pede a permissao de host. Chame como PRIMEIRA operacao assincrona do clique:
 * o Chrome recusa `permissions.request` fora do gesto do usuario, e qualquer
 * `await` antes dele ja encerra o gesto.
 */
export async function requestWebSearchPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: WEB_SEARCH_ORIGINS });
}

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchError';
  }
}

function isAbort(error: unknown): boolean {
  return (error as Error)?.name === 'AbortError';
}

/** Pedaco de HTML -> texto. O DDG traz `<a>`, `<b>` e entidades. */
function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

interface DdgTopic {
  Text?: string;
  FirstURL?: string;
  /** Topicos agrupados vem aninhados em `Topics`. */
  Topics?: DdgTopic[];
  Name?: string;
}

interface DdgResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  Answer?: string;
  RelatedTopics?: DdgTopic[];
}

function flattenTopics(topics: DdgTopic[], limite: number): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  for (const topic of topics) {
    if (out.length >= limite) break;
    if (Array.isArray(topic.Topics)) {
      out.push(...flattenTopics(topic.Topics, limite - out.length));
      continue;
    }
    const text = topic.Text ? stripHtml(topic.Text) : '';
    if (text) out.push({ text, url: topic.FirstURL ?? '' });
  }
  return out;
}

/**
 * Desembrulha um link de resultado do DuckDuckGo. Os `href` do HTML de busca
 * sao redirecionamentos (`//duckduckgo.com/l/?uddg=<url real>`); o `uddg` e'
 * quem guarda o destino. Link direto (sem `uddg`) passa como esta'.
 */
export function decodeDdgRedirect(href: string): string {
  if (!href) return '';
  const absoluta = href.startsWith('//') ? `https:${href}` : href;
  try {
    const url = new URL(absoluta);
    const destino = url.searchParams.get('uddg');
    if (destino) return destino.startsWith('//') ? `https:${destino}` : destino;
    return url.toString();
  } catch {
    return '';
  }
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Extrai os resultados organicos do HTML de busca do DuckDuckGo.
 *
 * O DDG nao oferece JSON para os resultados de busca; o HTML e' o contrato.
 * Em vez de `DOMParser` (que nao existe no service worker nem nos testes em
 * Node), a extracao e' por regex em cima das classes estaveis `result__a`
 * (titulo) e `result__snippet` (trecho). Se o markup mudar, o pior caso e' a
 * busca voltar vazia — nunca quebrar o turno.
 */
export function parseDdgResults(html: string): WebSearchResult[] {
  const links: { pos: number; title: string; url: string }[] = [];
  const snippets: { pos: number; text: string }[] = [];

  const tagRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    const attrs = match[1];
    const inner = match[2];
    if (/\bclass="[^"]*\bresult__a\b/.test(attrs)) {
      const href = /href="([^"]*)"/.exec(attrs)?.[1] ?? '';
      const title = stripHtml(inner);
      if (title && href) links.push({ pos: match.index, title, url: decodeDdgRedirect(href) });
    } else if (/\bclass="[^"]*\bresult__snippet\b/.test(attrs)) {
      const text = stripHtml(inner);
      if (text) snippets.push({ pos: match.index, text });
    }
  }

  // Titulo e trecho vivem em anchors separados; pareia pelo intervalo entre um
  // titulo e o proximo (o trecho de um resultado vem logo depois do titulo).
  return links
    .map((link, index) => {
      const proximo = links[index + 1]?.pos ?? html.length;
      const snippet = snippets.find((s) => s.pos >= link.pos && s.pos < proximo);
      return { title: link.title, url: link.url, snippet: snippet?.text ?? '' };
    })
    .filter((resultado) => resultado.title && resultado.url);
}

function limitarTrecho(texto: string, limite: number): string {
  if (texto.length <= limite) return texto;
  return `${texto.slice(0, limite).trimEnd()}...`;
}

function formatarResultados(resultados: WebSearchResult[]): string {
  if (resultados.length === 0) return '';
  const linhas = resultados.slice(0, 6).map((resultado) => {
    const trecho = resultado.snippet
      ? ` — ${limitarTrecho(resultado.snippet, 220)}`
      : '';
    return `- ${resultado.title}${trecho}\n  ${resultado.url}`;
  });
  return `Resultados da busca:\n${linhas.join('\n')}`;
}

async function fetchInstant(query: string, signal?: AbortSignal): Promise<DdgResponse> {
  const url = `${INSTANT_ENDPOINT}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) {
    throw new WebSearchError(`A busca na web respondeu ${response.status}.`);
  }
  try {
    return (await response.json()) as DdgResponse;
  } catch {
    throw new WebSearchError('A resposta da busca na web nao veio em JSON legivel.');
  }
}

function instantParts(data: DdgResponse): string[] {
  const partes: string[] = [];
  const abstract = stripHtml(data.AbstractText ?? '');
  const answer = stripHtml(data.Answer ?? '');

  if (answer) partes.push(answer);
  if (abstract) {
    partes.push(data.AbstractURL ? `${abstract}\nFonte: ${data.AbstractURL}` : abstract);
  }

  const topicos = flattenTopics(data.RelatedTopics ?? [], 5);
  if (topicos.length > 0) {
    partes.push(
      `Resultados relacionados:\n${topicos
        .map((topico) => `- ${topico.text}${topico.url ? ` (${topico.url})` : ''}`)
        .join('\n')}`,
    );
  }
  return partes;
}

async function fetchOrganic(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const url = `${RESULTS_ENDPOINT}?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    signal,
  });
  if (!response.ok) {
    throw new WebSearchError(`A busca na web respondeu ${response.status}.`);
  }
  try {
    return parseDdgResults(await response.text());
  } catch {
    throw new WebSearchError('A resposta da busca na web nao veio em HTML legivel.');
  }
}

/**
 * Pesquisa na web. Devolve texto pronto para entrar no resultado da ferramenta.
 *
 * Verbete primeiro: quando a resposta instantanea tem conteudo, ela ja responde
 * "o que e' X" melhor que uma lista de links. Vazia, a busca cai para os
 * resultados organicos. Lanca WebSearchError apenas quando NENHUMA fonte
 * respondeu (rede/permissoes) — resposta vazia de verdade vira um texto que
 * orienta a reformular, nunca uma quebra do turno.
 */
export async function webSearch(query: string, signal?: AbortSignal): Promise<string> {
  const limpa = query.trim();
  if (!limpa) throw new WebSearchError('Informe um termo para pesquisar.');

  const partes: string[] = [];
  let algumaResposta = false;

  try {
    partes.push(...instantParts(await fetchInstant(limpa, signal)));
    algumaResposta = true;
  } catch (error) {
    if (isAbort(error)) throw error;
  }

  if (partes.length === 0) {
    try {
      const resultados = await fetchOrganic(limpa, signal);
      algumaResposta = true;
      const bloco = formatarResultados(resultados);
      if (bloco) partes.push(bloco);
    } catch (error) {
      if (isAbort(error)) throw error;
    }
  }

  if (partes.length === 0) {
    if (!algumaResposta) {
      throw new WebSearchError(
        'A busca na web falhou por problema de rede (ou falta de permissao de host para o ' +
          'DuckDuckGo). Tente de novo.',
      );
    }
    return (
      `Nenhum resultado para "${limpa}" no DuckDuckGo. Pergunta muito recente ou ` +
      'especifica demais pode nao ter resposta. Reformule o termo em menos palavras, ou ' +
      'siga com o conhecimento que voce ja tem — e diga ao usuario que a pesquisa nao ajudou.'
    );
  }
  return partes.join('\n\n');
}
