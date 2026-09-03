import { describe, expect, it } from 'vitest';
import { MAX_RESULT_CHARS, TOOL_LABEL, targetOfCall, visibleResult } from '../toolTrace';
import { TOOL_SCHEMAS } from '../../lib/agent/tools';

describe('targetOfCall', () => {
  it('mostra o alvo da acao — o arquivo, a busca, a anotacao', () => {
    expect(targetOfCall({ path: 'src/App.tsx' })).toBe('src/App.tsx');
    expect(targetOfCall({ query: 'useEffect' })).toBe('useEffect');
    expect(targetOfCall({ summary: 'menu fica no rodape' })).toBe('menu fica no rodape');
  });

  it('nao quebra quando a acao nao tem alvo', () => {
    expect(targetOfCall({})).toBe('');
    expect(targetOfCall({ message: 'chore: ajusta build' })).toBe('');
  });

  it('serializa alvo que nao veio como texto, em vez de renderizar [object Object]', () => {
    expect(targetOfCall({ path: { estranho: true } })).toBe('{"estranho":true}');
  });
});

describe('visibleResult', () => {
  const resultado = (content: string) => ({ toolCallId: 'c1', name: 'read_file', content });

  it('mostra o conteudo inteiro quando ele cabe', () => {
    expect(visibleResult(resultado('conteudo do arquivo'))).toBe('conteudo do arquivo');
  });

  it('corta arquivo grande — 200 KB no DOM travam o painel', () => {
    const visivel = visibleResult(resultado('x'.repeat(MAX_RESULT_CHARS + 5_000)));
    expect(visivel.length).toBeLessThan(MAX_RESULT_CHARS + 200);
    expect(visivel).toContain('5000 caracteres a mais');
  });

  it('explica quando a acao nao chegou a terminar', () => {
    // Acontece de verdade: a conexao cai entre a chamada e o resultado.
    expect(visibleResult(undefined)).toContain('nao chegou a terminar');
  });
});

describe('TOOL_LABEL', () => {
  it('tem rotulo para toda ferramenta que o agente expoe', () => {
    // Ferramenta nova sem rotulo apareceria na conversa com o nome cru.
    const semRotulo = TOOL_SCHEMAS.map((tool) => tool.name).filter((nome) => !TOOL_LABEL[nome]);
    expect(semRotulo).toEqual([]);
  });
});
