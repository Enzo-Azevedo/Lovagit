/**
 * Busca na web para o agente.
 *
 * Fonte: o endpoint de "resposta instantanea" do DuckDuckGo
 * (`api.duckduckgo.com`). Escolhido por ser o unico caminho gratuito que nao
 * exige chave nem conta — a extensao nao pode inventar credencial de API, e
 * pedir uma chave so para pesquisar na internet afastaria quem so quer a
 * funcao ligada.
 *
 * O que ele devolve e' o resumo do verbete (Abstract) mais topicos
 * relacionados: suficiente para "o que e' X", "qual a sintaxe de Y",
 * "a versao atual de Z". Nao e' um varredor completo da web — para perguntas
 * muito recentes ou obscuras ele volta vazio, e o agente e' avisado disso.
 */

const ENDPOINT = 'https://api.duckduckgo.com/';

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchError';
  }
}

/** Pedaco de HTML -> texto. Os topicos do DDG trazem `<a>` e entidades. */
function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
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
 * Pesquisa na web. Devolve texto pronto para entrar no resultado da ferramenta.
 * Lanca WebSearchError quando a rede falha — a camada do agente transforma em
 * resultado de erro, nunca em quebra do turno.
 */
export async function webSearch(query: string, signal?: AbortSignal): Promise<string> {
  const limpa = query.trim();
  if (!limpa) throw new WebSearchError('Informe um termo para pesquisar.');

  const url = `${ENDPOINT}?q=${encodeURIComponent(limpa)}&format=json&no_html=1&skip_disambig=1`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new WebSearchError('A busca na web falhou por problema de rede. Tente de novo.');
  }
  if (!response.ok) {
    throw new WebSearchError(`A busca na web respondeu ${response.status}. Tente de novo.`);
  }

  let data: DdgResponse;
  try {
    data = (await response.json()) as DdgResponse;
  } catch {
    throw new WebSearchError('A resposta da busca na web nao veio em JSON legivel.');
  }

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

  if (partes.length === 0) {
    return (
      `Nenhum resultado direto para "${limpa}". A busca usada (DuckDuckGo) devolve ` +
      'resumos de verbetes, e nao uma varredura completa da web: para perguntas muito ' +
      'recentes ou especificas ela pode nao ter resposta. Reformule o termo, ou siga ' +
      'com o conhecimento que voce ja tem — e diga ao usuario que a pesquisa nao ajudou.'
    );
  }
  return partes.join('\n\n');
}
