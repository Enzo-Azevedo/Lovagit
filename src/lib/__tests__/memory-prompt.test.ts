import { describe, expect, it } from 'vitest';
import { assertNoForeignRepoLeak, createScope } from '../agent/isolation';
import { buildSystemPrompt } from '../agent/prompt';
import type { RepoMap } from '../types';
import { renderMemorySection, selectForPrompt } from '../memory/prompt';
import type { MemoryEntry, MemoryKind } from '../memory/types';

const DIA = 24 * 60 * 60 * 1000;

const escopo = createScope({
  id: 'o/x',
  owner: 'o',
  name: 'x',
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/o/x',
  private: false,
});

function entrada(
  id: string,
  kind: MemoryKind,
  createdAt: number,
  summary = `resumo ${id}`,
  repoId = 'o/x',
): MemoryEntry {
  return { id, repoId, kind, summary, createdAt, level: 1 };
}

describe('selectForPrompt', () => {
  it('escolhe do mais recente para o mais antigo e devolve em ordem cronologica', () => {
    const entradas = [
      entrada('a', 'action', 0),
      entrada('b', 'action', DIA),
      entrada('c', 'action', 2 * DIA),
    ];

    // Cada linha rende ~19 caracteres; 40 comporta duas.
    const escolhidas = selectForPrompt(entradas, 40);

    expect(escolhidas.map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('respeita o teto de caracteres', () => {
    const entradas = Array.from({ length: 200 }, (_, i) =>
      entrada(`e${i}`, 'action', i * DIA, 'x'.repeat(100)),
    );
    const rendered = selectForPrompt(entradas, 1000)
      .map((item) => item.summary)
      .join('\n');
    expect(rendered.length).toBeLessThanOrEqual(1000);
  });

  it('devolve vazio quando nem a primeira linha cabe', () => {
    expect(selectForPrompt([entrada('a', 'action', 0, 'x'.repeat(500))], 10)).toEqual([]);
  });
});

describe('renderMemorySection', () => {
  it('para na hora se uma entrada de outro repositorio chegar ao prompt', () => {
    // Ultima barreira do isolamento: memoria de outro projeto NAO vira prompt.
    const invasora = entrada('a', 'action', 0, 'segredo de outro projeto', 'o/y');
    expect(() => renderMemorySection(escopo, [invasora])).toThrow(/o\/y.*o\/x/);
  });

  it('nao rende nada quando a memoria esta vazia', () => {
    expect(renderMemorySection(escopo, [])).toBe('');
  });

  it('separa o que foi pedido do que foi aplicado', () => {
    const texto = renderMemorySection(escopo, [
      entrada('p', 'request', 0, 'trocar o header'),
      entrada('d', 'decision', DIA, 'nao usar biblioteca de data'),
      entrada('a', 'action', 2 * DIA, 'chore: atualiza header'),
    ]);

    const posPedidos = texto.indexOf('Ja pedido e combinado');
    const posAplicado = texto.indexOf('Ja aplicado no repositorio');
    expect(posPedidos).toBeGreaterThan(-1);
    expect(posAplicado).toBeGreaterThan(posPedidos);
    expect(texto).toContain('trocar o header');
    expect(texto).toContain('nao usar biblioteca de data');
    expect(texto).toContain('chore: atualiza header');
  });

  it('avisa o modelo de que o codigo vence a memoria', () => {
    // Sem isso a memoria velha vira fonte de verdade e o modelo age sobre um
    // arquivo que ja mudou — que e' o modo de a memoria atrapalhar.
    const texto = renderMemorySection(escopo, [entrada('a', 'action', 0)]);
    expect(texto).toContain('O codigo vence');
    expect(texto).toContain('nao e');
  });

  it('diz quantas entradas ficaram de fora do recorte', () => {
    const entradas = Array.from({ length: 50 }, (_, i) =>
      entrada(`e${i}`, 'action', i * DIA, 'y'.repeat(200)),
    );
    const texto = renderMemorySection(escopo, entradas, 500);
    expect(texto).toMatch(/\d+ entrada\(s\) mais antiga\(s\) fora deste recorte/);
  });

  it('mostra o sha curto do commit quando a entrada tem um', () => {
    const comCommit: MemoryEntry = {
      ...entrada('a', 'action', 0, 'chore: ajusta build'),
      refs: { commitSha: 'abcdef1234567890' },
    };
    const texto = renderMemorySection(escopo, [comCommit]);
    expect(texto).toContain('abcdef1');
    expect(texto).not.toContain('abcdef1234567890');
  });
});

const mapa: RepoMap = {
  repoId: 'o/x',
  defaultBranch: 'main',
  headSha: 'abc123',
  generatedAt: 0,
  entries: [{ path: 'src/index.ts', type: 'blob', sha: '1' }],
  truncated: false,
  languages: { TypeScript: 100 },
  stack: ['TypeScript'],
  entryPoints: ['src/index.ts'],
  highlights: [],
  fileCount: 1,
  dirCount: 1,
};

describe('memoria dentro do system prompt', () => {
  it('chega ao prompt do repositorio', () => {
    const prompt = buildSystemPrompt(escopo, mapa, true, [], [
      entrada('a', 'decision', 0, 'o menu fica no rodape, decidido em revisao'),
    ]);
    expect(prompt).toContain('Memoria deste repositorio');
    expect(prompt).toContain('o menu fica no rodape');
  });

  it('sai do caminho quando nao ha memoria — nada de secao vazia ocupando contexto', () => {
    const prompt = buildSystemPrompt(escopo, mapa, true, [], []);
    expect(prompt).not.toContain('Memoria deste repositorio');
  });

  it('o canario de vazamento cobre a memoria, alem do proprio render', () => {
    // Duas barreiras independentes: o render recusa a entrada forasteira, e o
    // canario pegaria o nome do outro repositorio se ela passasse por dentro.
    const prompt = buildSystemPrompt(escopo, mapa, true, [], [
      entrada('a', 'decision', 0, 'copiar o layout de acme/outro'),
    ]);
    expect(() => assertNoForeignRepoLeak(escopo, prompt, ['o/x', 'acme/outro'], '')).toThrow();
  });
});
