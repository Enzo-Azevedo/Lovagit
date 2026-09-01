import { describe, expect, it } from 'vitest';
import { buildFingerprint, normalizeMessage, topFrame } from '../telemetry/fingerprint';
import { buildIssueBody, buildIssueTitle, labelsFor } from '../telemetry/format';
import { LABELS, type ErrorReport } from '../telemetry/types';

function report(patch: Partial<ErrorReport> = {}): ErrorReport {
  return {
    id: 'err_1',
    fingerprint: 'abc12345',
    origin: 'extension',
    category: 'bug',
    name: 'TypeError',
    message: 'x.map nao e funcao',
    stack: 'TypeError: x\n    at run (assets/sidepanel.js)',
    context: { module: 'agent/loop' },
    extensionVersion: '0.2.0',
    browser: 'Chrome 140',
    createdAt: 1_756_000_000_000,
    occurrences: 1,
    ...patch,
  };
}

describe('normalizeMessage', () => {
  it('troca numeros, shas e datas por placeholders para agrupar ocorrencias', () => {
    expect(normalizeMessage('falhou no commit a1b2c3d4e5f6 em 2026-09-01T10:00:00Z apos 3 tentativas')).toBe(
      'falhou no commit <sha> em <data> apos <n> tentativas',
    );
  });
});

describe('topFrame', () => {
  it('pega o primeiro quadro e descarta linha/coluna', () => {
    const stack = 'TypeError: x\n    at doWork (assets/sidepanel.js:120:35)\n    at outra (a.js:1:1)';
    expect(topFrame(stack)).toBe('at doWork (assets/sidepanel.js');
  });
});

describe('buildFingerprint', () => {
  const base = {
    origin: 'extension',
    module: 'agent/loop',
    name: 'TypeError',
    message: 'falhou apos 3 tentativas',
    stack: 'at run (a.js:1:1)',
  };

  it('agrupa ocorrencias que so diferem em numeros e posicao no bundle', () => {
    expect(buildFingerprint(base)).toBe(
      buildFingerprint({ ...base, message: 'falhou apos 9 tentativas', stack: 'at run (a.js:5:9)' }),
    );
  });

  it('separa falhas de modulos diferentes', () => {
    expect(buildFingerprint(base)).not.toBe(buildFingerprint({ ...base, module: 'github/writer' }));
  });
});

describe('labelsFor', () => {
  it('erro da extensao recebe Alta Prioridade', () => {
    expect(labelsFor(report())).toEqual([LABELS.highPriority, LABELS.extensionError]);
  });

  it('erro de integracao entra com prioridade normal', () => {
    expect(labelsFor(report({ origin: 'integration' }))).toEqual([LABELS.integrationError]);
  });
});

describe('buildIssueBody', () => {
  it('inclui o marcador de fingerprint para deduplicar depois', () => {
    expect(buildIssueBody(report(), 'motivo')).toContain('<!-- lovagit-fp:abc12345 -->');
  });

  it('escreve a prioridade no corpo — labels somem sem push access', () => {
    expect(buildIssueBody(report(), 'motivo')).toContain('| Prioridade | **Alta** |');
    expect(buildIssueBody(report({ origin: 'integration' }), 'motivo')).toContain(
      '| Prioridade | Normal |',
    );
  });

  it('mostra o status HTTP quando existe', () => {
    expect(buildIssueBody(report({ status: 422 }), 'motivo')).toContain('| HTTP | 422 |');
    expect(buildIssueBody(report(), 'motivo')).not.toContain('| HTTP |');
  });
});

describe('buildIssueTitle', () => {
  it('identifica origem, classe e modulo', () => {
    expect(buildIssueTitle(report())).toBe('[extensao] TypeError em agent/loop: x.map nao e funcao');
    expect(buildIssueTitle(report({ origin: 'integration' }))).toContain('[integracao]');
  });
});
