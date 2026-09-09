import { describe, expect, it } from 'vitest';
import { finalizeToolCalls } from '../ai/openai-compatible';
import { describeTruncatedInput } from '../agent/tools';

/**
 * O caminho completo do defeito: o stream cai enquanto o modelo monta a
 * chamada, o JSON dos argumentos nao fecha, e a chamada seguia mesmo assim com
 * os campos virando string vazia. Um `read_file` com `path: ''` respondia "nao
 * encontrado", e o modelo lia isso como "o arquivo nao existe" — mudando de
 * rumo por causa de um defeito de transporte.
 */

describe('argumentos cortados', () => {
  it('JSON incompleto vira marca em vez de campo vazio', () => {
    const chamadas = finalizeToolCalls({
      text: '',
      reasoning: '',
      toolCalls: new Map([[0, { id: 'c1', name: 'read_file', args: '{"path":"src/Ap' }]]),
      finishReason: 'length',
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    expect(chamadas[0].input.__parseError).toBe('{"path":"src/Ap');
    // O ponto do defeito: sem a marca, `path` seria `undefined` e viraria ''.
    expect(chamadas[0].input.path).toBeUndefined();
  });

  it('a marca vira recusa que diz o que fazer', () => {
    const aviso = describeTruncatedInput({ __parseError: '{"path":"src/Ap' });

    expect(aviso).toMatch(/cortados/i);
    expect(aviso).toMatch(/nada foi executado/i);
    expect(aviso).toMatch(/refaca a chamada/i);
    // O trecho recebido ajuda o modelo a saber onde parou.
    expect(aviso).toContain('src/Ap');
  });

  it('chamada normal passa sem interferencia', () => {
    expect(describeTruncatedInput({ path: 'src/App.tsx' })).toBeNull();
    expect(describeTruncatedInput({})).toBeNull();
  });

  it('corta trecho gigante — a recusa e aviso, nao despejo', () => {
    const aviso = describeTruncatedInput({ __parseError: 'x'.repeat(5000) }) ?? '';
    expect(aviso.length).toBeLessThan(500);
  });

  it('nao confunde um campo chamado __parseError que nao seja texto', () => {
    expect(describeTruncatedInput({ __parseError: 42 })).toBeNull();
  });
});
