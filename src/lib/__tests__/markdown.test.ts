import { describe, expect, it } from 'vitest';
import { parseMarkdown, parseSpans, type ListBlock, type CodeBlock } from '../markdown';

describe('parseSpans', () => {
  it('reconhece negrito, enfase e codigo', () => {
    expect(parseSpans('um **forte** e um _leve_ e um `codigo`')).toEqual([
      { kind: 'text', text: 'um ' },
      { kind: 'strong', text: 'forte' },
      { kind: 'text', text: ' e um ' },
      { kind: 'em', text: 'leve' },
      { kind: 'text', text: ' e um ' },
      { kind: 'code', text: 'codigo' },
    ]);
  });

  it('o que esta em crase e literal — asterisco la dentro nao negrita', () => {
    expect(parseSpans('use `**nao**` assim')).toEqual([
      { kind: 'text', text: 'use ' },
      { kind: 'code', text: '**nao**' },
      { kind: 'text', text: ' assim' },
    ]);
  });

  it('aceita link http(s)', () => {
    expect(parseSpans('veja [os docs](https://exemplo.com/a)')).toEqual([
      { kind: 'text', text: 'veja ' },
      { kind: 'link', text: 'os docs', href: 'https://exemplo.com/a' },
    ]);
  });

  it('link com protocolo perigoso vira texto, nunca algo clicavel', () => {
    // Resposta de modelo e' texto de terceiro: um `javascript:` clicavel dentro
    // da extensao seria execucao de codigo de fora.
    const spans = parseSpans('[clique](javascript:alert(1))');
    expect(spans.some((span) => span.kind === 'link')).toBe(false);
    // O rotulo continua legivel; o destino aparece como texto, nao como alvo.
    const juntos = spans.map((span) => span.text).join('');
    expect(juntos).toContain('clique');
    expect(juntos).toContain('javascript:alert(1');
  });

  it('texto sem marcacao sai inteiro, sem virar lista vazia', () => {
    expect(parseSpans('so texto')).toEqual([{ kind: 'text', text: 'so texto' }]);
    expect(parseSpans('')).toEqual([{ kind: 'text', text: '' }]);
  });
});

describe('parseMarkdown', () => {
  it('separa titulo, paragrafo e regua', () => {
    const blocks = parseMarkdown('# Titulo\n\nUm paragrafo.\n\n---');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'rule']);
    expect(blocks[0]).toMatchObject({ level: 1 });
  });

  it('agrupa itens seguidos numa lista so', () => {
    const blocks = parseMarkdown('- um\n- dois\n- tres');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as ListBlock).items).toHaveLength(3);
    expect((blocks[0] as ListBlock).ordered).toBe(false);
  });

  it('distingue lista numerada de lista com marcador', () => {
    const blocks = parseMarkdown('1. um\n2. dois');
    expect((blocks[0] as ListBlock).ordered).toBe(true);
  });

  it('nao interpreta markdown dentro de bloco de codigo', () => {
    // `# isto` dentro de um bloco de shell e' comentario, nao titulo.
    const blocks = parseMarkdown('```bash\n# nao e titulo\n- nao e lista\n```');
    expect(blocks).toHaveLength(1);
    const bloco = blocks[0] as CodeBlock;
    expect(bloco.kind).toBe('code');
    expect(bloco.language).toBe('bash');
    expect(bloco.content).toBe('# nao e titulo\n- nao e lista');
  });

  it('fecha o bloco de codigo mesmo sem a cerca final', () => {
    // Acontece o tempo todo durante o streaming: o texto chega pela metade.
    const bloco = parseMarkdown('```ts\nconst x = 1;') [0] as CodeBlock;
    expect(bloco.kind).toBe('code');
    expect(bloco.content).toBe('const x = 1;');
  });

  it('junta linhas seguidas no mesmo paragrafo e separa na linha em branco', () => {
    const blocks = parseMarkdown('linha um\nlinha dois\n\noutro paragrafo');
    expect(blocks).toHaveLength(2);
  });

  it('le citacao', () => {
    const blocks = parseMarkdown('> atencao aqui');
    expect(blocks[0].kind).toBe('quote');
  });

  it('texto puro continua sendo um paragrafo — nada se perde', () => {
    const blocks = parseMarkdown('nenhuma marcacao aqui');
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'nenhuma marcacao aqui' }] },
    ]);
  });
});
