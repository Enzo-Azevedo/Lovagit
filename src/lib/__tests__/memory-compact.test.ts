import { describe, expect, it } from 'vitest';
import { dropDetail, entrySize, mergeEntries, reclaim, totalSize } from '../memory/compact';
import type { MemoryEntry, MemoryKind } from '../memory/types';

const DIA = 24 * 60 * 60 * 1000;

function entrada(
  id: string,
  repoId: string,
  kind: MemoryKind,
  createdAt: number,
  extra: Partial<MemoryEntry> = {},
): MemoryEntry {
  return {
    id,
    repoId,
    kind,
    summary: `resumo ${id}`,
    detail: 'x'.repeat(400),
    createdAt,
    level: 0,
    ...extra,
  };
}

describe('dropDetail', () => {
  it('tira o detalhe e preserva a linha que vai para o prompt', () => {
    const compacta = dropDetail(entrada('a', 'o/r', 'action', 0));
    expect(compacta.detail).toBeUndefined();
    expect(compacta.summary).toBe('resumo a');
    expect(compacta.level).toBe(1);
    expect(entrySize(compacta)).toBeLessThan(entrySize(entrada('a', 'o/r', 'action', 0)));
  });

  it('e idempotente — nao mexe no que ja foi comprimido', () => {
    const uma = dropDetail(entrada('a', 'o/r', 'action', 0));
    expect(dropDetail(uma)).toEqual(uma);
  });
});

describe('mergeEntries', () => {
  it('recusa fundir repositorios diferentes — isso seria vazamento, nao compressao', () => {
    expect(() =>
      mergeEntries([entrada('a', 'o/x', 'action', 0), entrada('b', 'o/y', 'action', 1)]),
    ).toThrow(/repositorios diferentes/);
  });

  it('recusa fundir tipos diferentes', () => {
    expect(() =>
      mergeEntries([entrada('a', 'o/x', 'action', 0), entrada('b', 'o/x', 'request', 1)]),
    ).toThrow(/tipos diferentes/);
  });

  it('conta as entradas, junta os caminhos e cobre o intervalo de datas', () => {
    const fundida = mergeEntries([
      entrada('a', 'o/x', 'action', 0, { refs: { paths: ['src/a.ts'] } }),
      entrada('b', 'o/x', 'action', 3 * DIA, { refs: { paths: ['src/b.ts', 'src/a.ts'] } }),
    ]);

    expect(fundida.level).toBe(2);
    expect(fundida.mergedCount).toBe(2);
    expect(fundida.summary).toContain('2 alteracoes');
    expect(fundida.summary).toContain('src/a.ts');
    expect(fundida.summary).toContain('src/b.ts');
    expect(fundida.createdAt).toBe(0);
    expect(fundida.untilAt).toBe(3 * DIA);
    expect(fundida.detail).toBeUndefined();
  });

  it('soma contagens ao fundir uma fusao com outra entrada', () => {
    const jaFundida = entrada('a', 'o/x', 'action', 0, { level: 2, mergedCount: 5 });
    const fundida = mergeEntries([jaFundida, entrada('b', 'o/x', 'action', DIA)]);
    expect(fundida.mergedCount).toBe(6);
    expect(fundida.summary).toContain('6 alteracoes');
  });
});

describe('reclaim', () => {
  it('nao mexe em nada quando cabe no orcamento', () => {
    const entradas = [entrada('a', 'o/x', 'action', 0), entrada('b', 'o/x', 'action', DIA)];
    expect(reclaim(entradas, 10_000)).toEqual(entradas);
  });

  it('tira o detalhe do mais antigo primeiro, preservando a resolucao do recente', () => {
    const entradas = [
      entrada('velha', 'o/x', 'action', 0),
      entrada('nova', 'o/x', 'action', 10 * DIA),
    ];
    // Cabe uma entrada completa e uma sem detalhe, mas nao as duas completas.
    const orcamento = entrySize(entradas[1]) + entrySize(dropDetail(entradas[0])) + 10;

    const resultado = reclaim(entradas, orcamento);

    expect(resultado.find((e) => e.id === 'velha')?.detail).toBeUndefined();
    expect(resultado.find((e) => e.id === 'nova')?.detail).toBeDefined();
  });

  it('funde quando tirar o detalhe nao basta, e nunca mistura repositorios', () => {
    const entradas = [
      entrada('x1', 'o/x', 'action', 0),
      entrada('x2', 'o/x', 'action', DIA),
      entrada('x3', 'o/x', 'action', 2 * DIA),
      entrada('y1', 'o/y', 'action', 3 * DIA),
    ];

    const resultado = reclaim(entradas, 400);

    // Cada entrada resultante continua pertencendo a um unico repositorio, e o
    // conteudo de um nunca aparece na linha do outro.
    for (const item of resultado) {
      expect(['o/x', 'o/y']).toContain(item.repoId);
    }
    expect(resultado.some((item) => item.repoId === 'o/y')).toBe(true);
    expect(totalSize(resultado)).toBeLessThan(totalSize(entradas));
  });

  it('comprime o repositorio mais antigo, nao o que acabou de escrever', () => {
    // O cenario descrito: um projeto encheu a memoria, e a pressao so aparece
    // quando o outro comeca a gravar. Quem perde resolucao e o antigo.
    const entradas = [
      entrada('antigo1', 'o/antigo', 'action', 0),
      entrada('antigo2', 'o/antigo', 'action', DIA),
      entrada('novo1', 'o/novo', 'action', 100 * DIA),
      entrada('novo2', 'o/novo', 'action', 101 * DIA),
    ];

    const semDetalhe = entradas.map(dropDetail);
    // Orcamento do tamanho exato do estado apos UMA fusao: aperta o suficiente
    // para forcar uma, e folgado o suficiente para nao forcar a segunda.
    const aposUmaFusao = [
      mergeEntries([semDetalhe[0], semDetalhe[1]]),
      semDetalhe[2],
      semDetalhe[3],
    ];
    const orcamento = totalSize(aposUmaFusao);
    expect(orcamento).toBeLessThan(totalSize(semDetalhe));

    const resultado = reclaim(entradas, orcamento);

    const fundidas = resultado.filter((item) => item.level === 2);
    expect(fundidas).toHaveLength(1);
    expect(fundidas[0].repoId).toBe('o/antigo');
    expect(resultado.filter((item) => item.repoId === 'o/novo')).toHaveLength(2);
  });

  it('converge sem laco infinito quando o orcamento e absurdo', () => {
    const entradas = [
      entrada('a', 'o/x', 'action', 0),
      entrada('b', 'o/x', 'request', DIA),
      entrada('c', 'o/y', 'action', 2 * DIA),
    ];

    const resultado = reclaim(entradas, 1);

    // Sobra uma linha por (repositorio, tipo): nada foi apagado, a linha do
    // tempo continua inteira mesmo sem caber.
    expect(resultado).toHaveLength(3);
    expect(new Set(resultado.map((item) => `${item.repoId} ${item.kind}`)).size).toBe(3);
  });

  it('devolve em ordem cronologica', () => {
    const entradas = [
      entrada('c', 'o/x', 'action', 2 * DIA),
      entrada('a', 'o/x', 'action', 0),
      entrada('b', 'o/x', 'action', DIA),
    ];
    expect(reclaim(entradas, 10_000).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});
