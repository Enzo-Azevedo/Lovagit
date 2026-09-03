/**
 * Markdown do que a IA responde.
 *
 * Duas decisoes que moldam o resto:
 *
 * 1. **Parser proprio, e nao uma biblioteca.** O que os modelos escrevem cabe
 *    num subconjunto pequeno e conhecido, e uma biblioteca de markdown completa
 *    entra no bundle inteira. Mais importante: nenhuma delas devolve HTML que
 *    possamos injetar sem `dangerouslySetInnerHTML`, e resposta de modelo e'
 *    texto de terceiro — nunca vira HTML aqui.
 * 2. **Parsing separado da renderizacao.** Este arquivo nao conhece React: ele
 *    devolve estrutura. Quem desenha e' o componente. Assim a gramatica inteira
 *    se testa sem montar nada na tela.
 */

export interface CodeBlock {
  kind: 'code';
  language: string;
  content: string;
}

export interface HeadingBlock {
  kind: 'heading';
  level: 1 | 2 | 3;
  spans: Span[];
}

export interface ParagraphBlock {
  kind: 'paragraph';
  spans: Span[];
}

export interface ListBlock {
  kind: 'list';
  ordered: boolean;
  items: Span[][];
}

export interface QuoteBlock {
  kind: 'quote';
  spans: Span[];
}

export interface RuleBlock {
  kind: 'rule';
}

export type Block = CodeBlock | HeadingBlock | ParagraphBlock | ListBlock | QuoteBlock | RuleBlock;

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/** Protocolos aceitos num link. `javascript:` num href e' execucao de terceiro. */
const SAFE_LINK = /^https?:\/\//i;

/**
 * Quebra uma linha em trechos formatados.
 *
 * A ordem importa: `code` vem primeiro porque o que esta dentro de crase e'
 * literal — `` `**x**` `` mostra os asteriscos em vez de negritar.
 */
export function parseSpans(line: string): Span[] {
  const spans: Span[] = [];
  const padrao =
    /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)\)/g;

  let ultimo = 0;
  for (let m = padrao.exec(line); m !== null; m = padrao.exec(line)) {
    if (m.index > ultimo) spans.push({ kind: 'text', text: line.slice(ultimo, m.index) });

    const [, codigo, forte1, forte2, enfase1, enfase2, rotulo, href] = m;
    if (codigo !== undefined) spans.push({ kind: 'code', text: codigo });
    else if (forte1 !== undefined || forte2 !== undefined) {
      spans.push({ kind: 'strong', text: forte1 ?? forte2 });
    } else if (enfase1 !== undefined || enfase2 !== undefined) {
      spans.push({ kind: 'em', text: enfase1 ?? enfase2 });
    } else if (rotulo !== undefined && href !== undefined) {
      // Link com protocolo estranho vira texto: o rotulo continua legivel e
      // nada clicavel aponta para onde nao devia.
      spans.push(
        SAFE_LINK.test(href)
          ? { kind: 'link', text: rotulo, href }
          : { kind: 'text', text: `${rotulo} (${href})` },
      );
    }
    ultimo = m.index + m[0].length;
  }

  if (ultimo < line.length) spans.push({ kind: 'text', text: line.slice(ultimo) });
  return spans.length > 0 ? spans : [{ kind: 'text', text: line }];
}

const CERCA = /^\s*```/;
const TITULO = /^(#{1,3})\s+(.*)$/;
const ITEM_LISTA = /^\s*[-*+]\s+(.*)$/;
const ITEM_NUMERADO = /^\s*\d+[.)]\s+(.*)$/;
const CITACAO = /^\s*>\s?(.*)$/;
const REGUA = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Converte a resposta em blocos.
 *
 * Uma passagem so, de cima para baixo. O bloco de codigo e' tratado antes de
 * tudo porque dentro dele nada e' markdown — `# isto` la dentro e' um
 * comentario de shell, nao um titulo.
 */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const linhas = text.split('\n');

  let paragrafo: string[] = [];
  const fecharParagrafo = () => {
    if (paragrafo.length === 0) return;
    blocks.push({ kind: 'paragraph', spans: parseSpans(paragrafo.join('\n')) });
    paragrafo = [];
  };

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];

    if (CERCA.test(linha)) {
      fecharParagrafo();
      const language = linha.replace(CERCA, '').trim();
      const conteudo: string[] = [];
      i++;
      while (i < linhas.length && !CERCA.test(linhas[i])) {
        conteudo.push(linhas[i]);
        i++;
      }
      blocks.push({ kind: 'code', language, content: conteudo.join('\n') });
      continue;
    }

    if (linha.trim() === '') {
      fecharParagrafo();
      continue;
    }

    if (REGUA.test(linha)) {
      fecharParagrafo();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const titulo = TITULO.exec(linha);
    if (titulo) {
      fecharParagrafo();
      blocks.push({
        kind: 'heading',
        level: titulo[1].length as 1 | 2 | 3,
        spans: parseSpans(titulo[2]),
      });
      continue;
    }

    const citacao = CITACAO.exec(linha);
    if (citacao) {
      fecharParagrafo();
      blocks.push({ kind: 'quote', spans: parseSpans(citacao[1]) });
      continue;
    }

    const naoNumerado = ITEM_LISTA.exec(linha);
    const numerado = naoNumerado ? null : ITEM_NUMERADO.exec(linha);
    if (naoNumerado || numerado) {
      fecharParagrafo();
      const ordered = numerado !== null;
      const items: Span[][] = [parseSpans((naoNumerado ?? numerado)![1])];

      // Consome os itens seguintes do MESMO tipo: uma lista por bloco.
      while (i + 1 < linhas.length) {
        const proxima = linhas[i + 1];
        const seguinte = ordered ? ITEM_NUMERADO.exec(proxima) : ITEM_LISTA.exec(proxima);
        if (!seguinte) break;
        items.push(parseSpans(seguinte[1]));
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    paragrafo.push(linha);
  }

  fecharParagrafo();
  return blocks;
}
