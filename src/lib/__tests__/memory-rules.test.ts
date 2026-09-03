import { describe, expect, it } from 'vitest';
import { extractRule, isRuleSentence } from '../memory/rules';

describe('extractRule', () => {
  it('pega a regra sem o usuario pedir para guardar', () => {
    expect(extractRule('sempre use aspas simples neste projeto')).toBe(
      'sempre use aspas simples neste projeto',
    );
    expect(extractRule('nunca commite direto na main')).toBe('nunca commite direto na main');
    expect(extractRule('a partir de agora os testes ficam em __tests__')).toBe(
      'a partir de agora os testes ficam em __tests__',
    );
  });

  it('reconhece obrigacao sem verbo de acao na frase', () => {
    expect(extractRule('todo componente novo sempre deve ter teste')).toBe(
      'todo componente novo sempre deve ter teste',
    );
  });

  it('reconhece regra escrita em ingles', () => {
    expect(extractRule('from now on the API returns camelCase')).not.toBeNull();
    expect(extractRule('always run the linter before committing')).not.toBeNull();
  });

  it('acento nao muda o resultado', () => {
    expect(extractRule('por padrão o idioma é português')).not.toBeNull();
    expect(extractRule('convenção: nomes de arquivo em kebab-case')).not.toBeNull();
  });

  it('guarda so a frase da regra, nao a mensagem inteira', () => {
    // Guardar o texto todo colocaria a tarefa do dia dentro de uma entrada que
    // promete valer para sempre.
    const texto = 'Ajuste o header da home. E sempre use aspas simples.';
    expect(extractRule(texto)).toBe('E sempre use aspas simples.');
  });

  it('junta as regras quando ha mais de uma', () => {
    const texto = 'Nunca use var.\nPrefira const.\nO botao fica azul.';
    expect(extractRule(texto)).toBe('Nunca use var. Prefira const.');
  });

  it('pedido do dia nao e regra', () => {
    // O imperativo sozinho e' tarefa de hoje. Vira memoria pelo caminho comum
    // (`request`), quando o turno mexe em arquivo — nao como regra permanente.
    expect(extractRule('ajuste o header da home')).toBeNull();
    expect(extractRule('crie um componente de card e commite')).toBeNull();
    expect(extractRule('leia o App.tsx e me explica o que ele faz')).toBeNull();
  });

  it('relato de defeito nao vira regra, mesmo dizendo "sempre"', () => {
    // "sempre" tambem aparece em descricao de problema. Sem verbo de acao nem
    // obrigacao, a frase descreve — nao estabelece.
    expect(extractRule('sempre que eu clico no botao da erro 500')).toBeNull();
    expect(extractRule('esse bug acontece sempre no Firefox')).toBeNull();
    expect(extractRule('a build nunca termina, fica travada')).toBeNull();
  });

  it('caminho e versao nao quebram a frase ao meio', () => {
    const texto = 'Mexi no src/lib/x.ts na versao 0.4.1. Sempre rode os testes antes.';
    expect(extractRule(texto)).toBe('Sempre rode os testes antes.');
  });

  it('texto sem regra nenhuma devolve null', () => {
    expect(extractRule('oi, tudo bem?')).toBeNull();
    expect(extractRule('')).toBeNull();
  });
});

describe('isRuleSentence', () => {
  it('separa a frase que estabelece da frase que descreve', () => {
    expect(isRuleSentence('evite dependencia nova')).toBe(true);
    expect(isRuleSentence('regra: um commit por assunto')).toBe(true);
    expect(isRuleSentence('o commit anterior quebrou o build')).toBe(false);
  });
});
