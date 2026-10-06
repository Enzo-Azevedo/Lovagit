import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WebSearchError,
  decodeDdgRedirect,
  parseDdgResults,
  webSearch,
} from '../web/search';

/**
 * A busca web so consultava a resposta instantanea do DuckDuckGo, que devolve
 * verbete. Para pergunta tecnica ("qual o input X da action Y?") ela voltava
 * vazia — nao por falta de resposta na web, mas por nao consultar os resultados
 * de busca. A correcao adiciona os resultados organicos como fallback.
 */

const HTML_RESULTADOS = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgradle.org%2Fguides%2Fsetup-gradle%2F&amp;rut=abc123">Gradle <b>Setup</b> Guide</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgradle.org%2Fguides%2Fsetup-gradle%2F">The setup-gradle action configures &amp; runs Gradle.</a>
  </div>
</div>
<div class="result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://docs.github.com/en/actions">GitHub Actions documentation</a>
  </h2>
  <a class="result__snippet" href="https://docs.github.com/en/actions">Automate, customize, and execute your workflows.</a>
</div>
<nav><a class="nav-link" href="https://duckduckgo.com/about">Sobre</a></nav>
`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodeDdgRedirect', () => {
  it('extrai o destino real do redirecionamento uddg', () => {
    const href =
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fgradle.org%2Fguides%2Fsetup-gradle%2F&rut=abc';
    expect(decodeDdgRedirect(href)).toBe('https://gradle.org/guides/setup-gradle/');
  });

  it('passa link direto como esta', () => {
    expect(decodeDdgRedirect('https://docs.github.com/en/actions')).toBe(
      'https://docs.github.com/en/actions',
    );
  });

  it('normaliza destino protocolo-relativo', () => {
    expect(decodeDdgRedirect('//duckduckgo.com/l/?uddg=//example.com/docs')).toBe(
      'https://example.com/docs',
    );
  });

  it('vazio ou invalido devolve vazio', () => {
    expect(decodeDdgRedirect('')).toBe('');
    expect(decodeDdgRedirect('nao e uma url')).toBe('');
  });
});

describe('parseDdgResults', () => {
  it('extrai titulo, url e trecho de cada resultado', () => {
    const resultados = parseDdgResults(HTML_RESULTADOS);

    expect(resultados).toHaveLength(2);
    expect(resultados[0]).toEqual({
      title: 'Gradle Setup Guide',
      url: 'https://gradle.org/guides/setup-gradle/',
      snippet: 'The setup-gradle action configures & runs Gradle.',
    });
    expect(resultados[1]).toEqual({
      title: 'GitHub Actions documentation',
      url: 'https://docs.github.com/en/actions',
      snippet: 'Automate, customize, and execute your workflows.',
    });
  });

  it('ignora anchors que nao sao resultado (nav, rodape)', () => {
    const resultados = parseDdgResults(
      '<a class="nav-link" href="https://duckduckgo.com/about">Sobre</a>',
    );
    expect(resultados).toEqual([]);
  });

  it('markup desconhecido vira lista vazia, nunca erro', () => {
    expect(parseDdgResults('<html><body>nada util</body></html>')).toEqual([]);
    expect(parseDdgResults('')).toEqual([]);
  });
});

describe('webSearch', () => {
  it('recorre aos resultados organicos quando o verbete vem vazio', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const alvo = String(url);
      if (alvo.includes('api.duckduckgo.com')) {
        return jsonResponse({ AbstractText: '', Answer: '', RelatedTopics: [] });
      }
      return htmlResponse(HTML_RESULTADOS);
    });
    vi.stubGlobal('fetch', fetchMock);

    const texto = await webSearch('setup-gradle build-scan-terms-of-use-agree');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(texto).toContain('Gradle Setup Guide');
    expect(texto).toContain('https://gradle.org/guides/setup-gradle/');
  });

  it('usa o verbete e nao consulta os resultados quando ha resposta instantanea', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        AbstractText: 'O Gradle e uma ferramenta de build.',
        AbstractURL: 'https://gradle.org',
        Answer: '',
        RelatedTopics: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const texto = await webSearch('o que e gradle');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(texto).toContain('O Gradle e uma ferramenta de build.');
    expect(texto).toContain('https://gradle.org');
  });

  it('relata problema de rede apenas quando nenhuma fonte respondeu', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(webSearch('gradle')).rejects.toThrow(WebSearchError);
    await expect(webSearch('gradle')).rejects.toThrow(/problema de rede/i);
  });

  it('propaga cancelamento em vez de traduzir como erro de busca', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('Cancelado', 'AbortError');
      }),
    );

    await expect(webSearch('gradle')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resposta vazia de verdade vira orientacao, nao erro de rede', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const alvo = String(url);
      if (alvo.includes('api.duckduckgo.com')) {
        return jsonResponse({ AbstractText: '', Answer: '', RelatedTopics: [] });
      }
      return htmlResponse('<html><body>sem resultados</body></html>');
    });
    vi.stubGlobal('fetch', fetchMock);

    const texto = await webSearch('termo muito especifico sem resposta nenhuma');

    expect(texto).toMatch(/Nenhum resultado/);
    expect(texto).toMatch(/reformule/i);
  });
});
