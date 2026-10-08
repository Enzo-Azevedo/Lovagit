/**
 * Busca na web para o agente.
 *
 * Tres fontes, todas gratuitas e sem chave nem conta:
 *
 * 1. Resposta instantanea (`api.duckduckgo.com`): o Abstract/Answer e os
 *    topicos relacionados. Boa para "o que e' X", "qual a sintaxe de Y".
 *
 * 2. Resultados organicos (`html.duckduckgo.com/html`, GET e POST): titulo,
 *    trecho e link de cada resultado de busca. A resposta instantanea sozinha
 *    voltava vazia para pergunta tecnica — "qual o input X da action Y?" nao
 *    tem pagina de enciclopedia, mas tem milhares de paginas na web. O GET
 *    passou a devolver pagina de desafio em algumas consultas; o POST e'
 *    tentado em seguida como primeira alternativa.
 *
 * 3. Versao lite (`lite.duckduckgo.com/lite`): HTML mais pobre, feito para
 *    navegador sem JavaScript — por isso menos protegido. E' a ultima cartada
 *    quando o endpoint HTML principal devolve desafio ou markup que mudou.
 *
 * Nenhuma delas e' uma varredura completa da web: pergunta muito recente ou
 * obscura ainda pode voltar vazia, e o agente e' avisado disso.
 */

const INSTANT_ENDPOINT = 'https://api.duckduckgo.com/';
const RESULTS_ENDPOINT = 'https://html.duckduckgo.com/html/';
const LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';

/**
 * Hosts que a busca alcanca. Precisam de permissao de host: sem ela, o fetch
 * sai de uma pagina de extensao como requisicao cross-origin comum e o
 * navegador barra ANTES de a rede ser usada — o sintoma vira "problema de
 * rede", nunca "sem resultado". O `duckduckgo.com` entra porque os endpoints
 * HTML/lite podem redirecionar para a raiz do dominio, e o subdominio lite
 * cai no coringa `*.duckduckgo.com`.
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

/**
 * Link do proprio DuckDuckGo? Nav, paginacao e sugestoes nao sao resultado.
 * A versao lite mistura resultados externos com links internos; so os externos
 * interessam ao agente.
 */
function isInternalDdg(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com');
  } catch {
    return true;
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

/**
 * Extrai os resultados da versao lite do DuckDuckGo.
 *
 * O markup lite e' mais pobre que o do endpoint HTML principal: o titulo nao
 * carrega `class="result__a"` — e' um `<a rel="nofollow">` comum apontando para
 * o redirecionamento `uddg`. Em vez de depender de classe que muda, usa o que
 * nao muda: link de resultado externo (destino fora do duckduckgo.com). O
 * trecho fica de fora de proposito — titulo + link ja tiram a busca do vazio.
 */
export function parseLiteResults(html: string): WebSearchResult[] {
  const resultados: WebSearchResult[] = [];
  const vistos = new Set<string>();

  const tagRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    const href = /href="([^"]*)"/.exec(match[1])?.[1] ?? '';
    const title = stripHtml(match[2]);
    if (!title || !href) continue;
    const destino = decodeDdgRedirect(href);
    if (!destino || isInternalDdg(destino)) continue;
    if (vistos.has(destino)) continue;
    vistos.add(destino);
    resultados.push({ title, url: destino, snippet: '' });
  }
  return resultados;
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

/** HTML de resultados em texto, ou erro traduzido. Lanca WebSearchError. */
async function htmlParaResultados(
  response: Response,
  parser: (html: string) => WebSearchResult[],
): Promise<WebSearchResult[]> {
  if (!response.ok) {
    throw new WebSearchError(`A busca na web respondeu ${response.status}.`);
  }
  try {
    return parser(await response.text());
  } catch {
    throw new WebSearchError('A resposta da busca na web nao veio em HTML legivel.');
  }
}

async function fetchOrganic(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const url = `${RESULTS_ENDPOINT}?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    signal,
  });
  return htmlParaResultados(response, parseDdgResults);
}

/**
 * Mesmo endpoint HTML, mas por POST. O DuckDuckGo ja devolveu pagina de desafio
 * para GET; o formulario real do endpoint e' POST, entao a chance de resposta
 * util e' maior. Custa uma requisicao a mais e so entra quando o GET falha.
 */
async function fetchOrganicPost(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const response = await fetch(RESULTS_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  return htmlParaResultados(response, parseDdgResults);
}

async function fetchLite(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const url = `${LITE_ENDPOINT}?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    signal,
  });
  return htmlParaResultados(response, parseLiteResults);
}

/**
 * Pesquisa na web. Devolve texto pronto para entrar no resultado da ferramenta.
 *
 * Verbete primeiro: quando a resposta instantanea tem conteudo, ela ja responde
 * "o que e' X" melhor que uma lista de links. Vazia, a busca cai para os
 * resultados organicos em cascata (GET, POST e lite) e para na primeira que
 * devolver resultado legivel. Lanca WebSearchError apenas quando NENHUMA fonte
 * respondeu (rede/permissoes) — resposta vazia de verdade vira um texto que
 * orienta a reformular, nunca uma quebra do turno.
 */
export async function webSearch(query: string, signal?: AbortSignal): Promise<string> {
  const limpa = query.trim();
  if (!limpa) throw new WebSearchError('Informe um termo para pesquisar.');

  const partes: string[] = [];
  // Alguma fonte COMPLETOU a requisicao (mesmo que vazia)? Distingue "nao tem
  // resultado" de "nem chegou a rede" — so o segundo e' erro de verdade.
  let algumaFonteRespondeu = false;

  try {
    partes.push(...instantParts(await fetchInstant(limpa, signal)));
    algumaFonteRespondeu = true;
  } catch (error) {
    if (isAbort(error)) throw error;
  }

  if (partes.length === 0) {
    const fontes: Array<() => Promise<WebSearchResult[]>> = [
      () => fetchOrganic(limpa, signal),
      () => fetchOrganicPost(limpa, signal),
      () => fetchLite(limpa, signal),
    ];
    for (const buscar of fontes) {
      try {
        const resultados = await buscar();
        algumaFonteRespondeu = true;
        const bloco = formatarResultados(resultados);
        if (bloco) {
          partes.push(bloco);
          break;
        }
      } catch (error) {
        if (isAbort(error)) throw error;
      }
    }
  }

  if (partes.length === 0) {
    if (!algumaFonteRespondeu) {
      throw new WebSearchError(
        'A busca na web falhou por problema de rede (ou falta de permissao de host para o ' +
          'DuckDuckGo). Tente de novo.',
      );
    }
    return (
      `Nenhum resultado legivel para "${limpa}" no DuckDuckGo. Isso pode ser ausencia real ` +
      'de resposta (termo muito recente ou especifico) ou a busca ter sido bloqueada. ' +
      'Reformule em poucas palavras, em linguagem natural e SEM aspas; se continuar vazio, ' +
      'siga com o conhecimento que voce ja tem — e diga ao usuario que a pesquisa nao ajudou.'
    );
  }
  return partes.join('\n\n');
}
