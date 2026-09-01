import { describe, expect, it } from 'vitest';
import { collapseContext, diffLines, diffStats } from '../diff';

describe('diffLines', () => {
  it('marca linhas adicionadas, removidas e mantidas', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc');
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
    expect(lines.filter((line) => line.type === 'ctx').map((line) => line.text)).toEqual(['a', 'c']);
  });

  it('trata criacao de arquivo como adicao pura', () => {
    expect(diffStats(diffLines('', 'nova\nlinha'))).toEqual({ added: 2, removed: 0 });
  });

  it('trata remocao de arquivo como delecao pura', () => {
    expect(diffStats(diffLines('linha', ''))).toEqual({ added: 0, removed: 1 });
  });
});

describe('collapseContext', () => {
  it('colapsa blocos longos sem alteracao', () => {
    const before = Array.from({ length: 40 }, (_, i) => `linha ${i}`).join('\n');
    const after = before.replace('linha 20', 'linha 20 alterada');
    const collapsed = collapseContext(diffLines(before, after), 2);
    expect(collapsed.some((line) => line.type === 'gap')).toBe(true);
    expect(collapsed.length).toBeLessThan(20);
  });
});
