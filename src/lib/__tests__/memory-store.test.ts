import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Stub minimo de `chrome`, para exercitar o namespacing e a cota de verdade. */
const store = new Map<string, unknown>();
let permissoes = new Set<string>();

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
      remove: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      },
      // O Chrome mede pela serializacao JSON; o stub faz o mesmo, para o
      // caminho rapido do orcamento ser exercitado de verdade.
      getBytesInUse: async (keys: string[]) =>
        keys.reduce(
          (soma, key) => soma + (store.has(key) ? JSON.stringify(store.get(key)).length : 0),
          0,
        ),
    },
  },
  permissions: {
    contains: async ({ permissions }: { permissions: string[] }) =>
      permissions.every((permissao) => permissoes.has(permissao)),
    request: async ({ permissions }: { permissions: string[] }) => {
      for (const permissao of permissions) permissoes.add(permissao);
      return true;
    },
  },
});

const {
  BUDGET_SEM_PERMISSAO_BYTES,
  clearRepoMemory,
  effectiveBudgetBytes,
  forgetMemoryEntry,
  loadMemory,
  memoryUsage,
  recordMemory,
  trimForMemory,
} = await import('../memory/store');
const { saveSettings } = await import('../storage');

beforeEach(async () => {
  store.clear();
  permissoes = new Set();
  await saveSettings({ connectedRepoIds: ['o/alfa', 'o/beta'] });
});

describe('gravacao e isolamento', () => {
  it('guarda por repositorio e uma conversa nao enxerga a memoria da outra', async () => {
    await recordMemory({ repoId: 'o/alfa', kind: 'decision', summary: 'segredo do alfa' });
    await recordMemory({ repoId: 'o/beta', kind: 'decision', summary: 'segredo do beta' });

    const alfa = await loadMemory('o/alfa');
    const beta = await loadMemory('o/beta');

    expect(alfa.map((e) => e.summary)).toEqual(['segredo do alfa']);
    expect(beta.map((e) => e.summary)).toEqual(['segredo do beta']);
    expect(JSON.stringify(alfa)).not.toContain('beta');
  });

  it('grava na chave namespaced do repositorio', async () => {
    await recordMemory({ repoId: 'o/alfa', kind: 'action', summary: 'commit' });
    expect(store.has('repo:o/alfa:memory')).toBe(true);
  });

  it('esquece uma entrada e limpa o repositorio inteiro', async () => {
    const uma = await recordMemory({ repoId: 'o/alfa', kind: 'action', summary: 'primeira' });
    await recordMemory({ repoId: 'o/alfa', kind: 'action', summary: 'segunda' });

    const restantes = await forgetMemoryEntry('o/alfa', uma.id);
    expect(restantes.map((e) => e.summary)).toEqual(['segunda']);

    await clearRepoMemory('o/alfa');
    expect(await loadMemory('o/alfa')).toEqual([]);
  });
});

describe('trimForMemory', () => {
  it('colapsa espaco e corta o que e longo demais para virar memoria', () => {
    expect(trimForMemory('  ola \n\n  mundo  ')).toBe('ola mundo');
    const cortado = trimForMemory('x'.repeat(500), 100);
    expect(cortado).toHaveLength(100);
    expect(cortado.endsWith('…')).toBe(true);
  });
});

describe('orcamento', () => {
  it('limita a cota real enquanto a permissao nao valer nesta instalacao', async () => {
    // `unlimitedStorage` e' concedida na instalacao — o Chrome nao aceita
    // pedi-la em runtime. Ate a extensao ser recarregada, o teto menor e' o
    // lado seguro: estourar a cota derrubaria gravacoes de outras chaves.
    await saveSettings({ memoryBudgetBytes: 1_073_741_824 });
    expect(await effectiveBudgetBytes()).toBe(BUDGET_SEM_PERMISSAO_BYTES);

    permissoes.add('unlimitedStorage');
    expect(await effectiveBudgetBytes()).toBe(1_073_741_824);
  });

  it('e do conjunto: escrever num repositorio comprime o passado do outro', async () => {
    // O cenario descrito: o alfa encheu sozinho, e a pressao so aparece quando
    // o beta comeca a gravar.
    await saveSettings({ memoryBudgetBytes: 1_073_741_824 });
    for (let i = 0; i < 40; i++) {
      await recordMemory({
        repoId: 'o/alfa',
        kind: 'action',
        summary: `alteracao ${i}`,
        detail: 'd'.repeat(2000),
      });
    }

    const alfaAntes = await loadMemory('o/alfa');
    // Teto exatamente no que o alfa ja ocupa: ele coube inteiro, e agora
    // qualquer byte novo — de qualquer repositorio — force a compressao.
    const usoAntes = await memoryUsage();
    await saveSettings({ memoryBudgetBytes: usoAntes.bytes });
    expect(alfaAntes).toHaveLength(40);

    await recordMemory({
      repoId: 'o/beta',
      kind: 'action',
      summary: 'primeira do beta',
      detail: 'b'.repeat(300),
    });

    const alfaDepois = await loadMemory('o/alfa');
    const beta = await loadMemory('o/beta');

    // O beta entrou inteiro; o alfa perdeu resolucao para abrir espaco.
    expect(beta).toHaveLength(1);
    expect(beta[0].summary).toBe('primeira do beta');
    expect(JSON.stringify(alfaDepois).length).toBeLessThan(JSON.stringify(alfaAntes).length);

    // E o total continua dentro do teto.
    const usoDepois = await memoryUsage();
    expect(usoDepois.bytes).toBeLessThanOrEqual(usoDepois.budgetBytes);
  });

  it('nunca apaga um repositorio inteiro para caber', async () => {
    await saveSettings({ memoryBudgetBytes: 64 * 1024 });
    for (let i = 0; i < 40; i++) {
      await recordMemory({
        repoId: i % 2 === 0 ? 'o/alfa' : 'o/beta',
        kind: 'action',
        summary: `alteracao ${i}`,
        detail: 'z'.repeat(2000),
      });
    }

    expect((await loadMemory('o/alfa')).length).toBeGreaterThan(0);
    expect((await loadMemory('o/beta')).length).toBeGreaterThan(0);
  });

  it('nao comprime nada enquanto o total cabe, mesmo com muita entrada', async () => {
    // O caminho rapido mede sem carregar; o que importa e que ele nao comprima
    // por engano quando ha espaco.
    await saveSettings({ memoryBudgetBytes: 1_073_741_824 });
    for (let i = 0; i < 20; i++) {
      await recordMemory({
        repoId: 'o/alfa',
        kind: 'action',
        summary: `alteracao ${i}`,
        detail: 'd'.repeat(500),
      });
    }

    const entradas = await loadMemory('o/alfa');
    expect(entradas).toHaveLength(20);
    expect(entradas.every((entrada) => entrada.level === 0)).toBe(true);
    expect(entradas.every((entrada) => entrada.detail !== undefined)).toBe(true);
  });

  it('grava dois fatos seguidos sem perder nenhum', async () => {
    // Um turno emite o commit e o pedido quase juntos; gravacao em paralelo
    // sobre a mesma chave perderia um em silencio.
    await Promise.all([
      recordMemory({ repoId: 'o/alfa', kind: 'action', summary: 'commit' }),
      recordMemory({ repoId: 'o/alfa', kind: 'request', summary: 'pedido' }),
    ]);

    const entradas = await loadMemory('o/alfa');
    expect(entradas.map((e) => e.summary).sort()).toEqual(['commit', 'pedido']);
  });

  it('relata o uso por repositorio, do maior para o menor', async () => {
    await recordMemory({ repoId: 'o/alfa', kind: 'action', summary: 'a', detail: 'x'.repeat(400) });
    await recordMemory({ repoId: 'o/beta', kind: 'action', summary: 'b' });

    const uso = await memoryUsage();
    expect(uso.entries).toBe(2);
    expect(uso.byRepo[0].repoId).toBe('o/alfa');
    expect(uso.byRepo[0].bytes).toBeGreaterThan(uso.byRepo[1].bytes);
  });
});
