import { describe, expect, it } from 'vitest';
import { explainStepCeiling, explainStopReason } from '../agent/ending';

/**
 * Regressao do sintoma "o agente para de analisar no meio do turno": todo
 * encerramento tinha que virar aviso, e dois nao viravam — o teto de passos e o
 * corte por teto de tokens. Na tela, os dois ficavam identicos a um turno que
 * terminou bem.
 */

describe('explainStopReason', () => {
  it('fim normal nao gera aviso', () => {
    // Avisar aqui encheria a tela de ruido em todo turno bem-sucedido.
    expect(explainStopReason('stop')).toBeNull();
    expect(explainStopReason('tool_calls')).toBeNull();
    expect(explainStopReason('')).toBeNull();
  });

  it('`length` avisa que a resposta esta cortada, e diz o que ajustar', () => {
    const aviso = explainStopReason('length');
    expect(aviso).toContain('cortada');
    expect(aviso).toContain('Maximo de tokens');
  });

  it('explica que o raciocinio consome o mesmo teto', () => {
    // E' o que fecha o caso do Gemini: o pensamento gasta o orcamento da
    // resposta, e o turno acaba antes do que o usuario espera.
    expect(explainStopReason('length')).toMatch(/pensamento consome esse mesmo teto/i);
  });

  it('aceita a grafia alternativa do motivo', () => {
    expect(explainStopReason('MAX_TOKENS')).not.toBeNull();
    expect(explainStopReason('Length')).not.toBeNull();
  });

  it('filtro de conteudo tem aviso proprio', () => {
    // Causa diferente exige acao diferente: reformular, nao aumentar teto.
    const aviso = explainStopReason('content_filter');
    expect(aviso).toContain('filtro de conteudo');
    expect(aviso).not.toContain('Maximo de tokens');
  });

  it('motivo desconhecido nao inventa explicacao', () => {
    expect(explainStopReason('motivo_que_nao_conhecemos')).toBeNull();
  });
});

describe('explainStepCeiling', () => {
  it('diz o numero e que o modelo NAO tinha terminado', () => {
    // Muda o que o usuario faz em seguida: pedir continuacao em vez de repetir
    // o pedido inteiro e pagar tudo de novo.
    const aviso = explainStepCeiling(16);
    expect(aviso).toContain('16 passos');
    expect(aviso).toMatch(/nao tinha terminado/i);
    expect(aviso).toMatch(/continuar de onde parou/i);
  });

  it('avisa que o trabalho ja feito continua valendo', () => {
    expect(explainStepCeiling(16)).toMatch(/continua valendo/i);
  });
});
