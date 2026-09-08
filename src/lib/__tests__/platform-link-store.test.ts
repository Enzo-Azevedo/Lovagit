import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [chave, valor] of Object.entries(items)) store.set(chave, valor);
      },
      remove: async () => {},
    },
  },
});

const {
  getRepoProjectRef,
  pruneRepoFromLinks,
  setRepoProjectRef,
} = await import('../platforms/store');

beforeEach(() => store.clear());

describe('vinculo repositorio -> projeto', () => {
  it('nao tem padrao: sem escolha, nao ha projeto', async () => {
    // Chutar aqui seria escolher o banco de producao de outra pessoa.
    await expect(getRepoProjectRef('supabase', 'acme/site')).resolves.toBeNull();
  });

  it('cada repositorio guarda o seu, e um nao enxerga o do outro', async () => {
    await setRepoProjectRef('supabase', 'acme/site', 'ref-do-site');
    await setRepoProjectRef('supabase', 'acme/api', 'ref-da-api');

    await expect(getRepoProjectRef('supabase', 'acme/site')).resolves.toBe('ref-do-site');
    await expect(getRepoProjectRef('supabase', 'acme/api')).resolves.toBe('ref-da-api');
    await expect(getRepoProjectRef('supabase', 'acme/outro')).resolves.toBeNull();
  });

  it('trocar a escolha substitui, nao acumula', async () => {
    await setRepoProjectRef('supabase', 'acme/site', 'antigo');
    await setRepoProjectRef('supabase', 'acme/site', 'novo');
    await expect(getRepoProjectRef('supabase', 'acme/site')).resolves.toBe('novo');
  });

  it('null desfaz o vinculo', async () => {
    await setRepoProjectRef('supabase', 'acme/site', 'ref1');
    await setRepoProjectRef('supabase', 'acme/site', null);
    await expect(getRepoProjectRef('supabase', 'acme/site')).resolves.toBeNull();
  });

  it('desconectar o repositorio leva o vinculo junto', async () => {
    // Um repositorio removido nao pode deixar para tras um ponteiro para um
    // banco — se ele voltar depois, a escolha tem que ser feita de novo.
    await setRepoProjectRef('supabase', 'acme/site', 'ref1');
    await setRepoProjectRef('supabase', 'acme/api', 'ref2');

    await pruneRepoFromLinks('acme/site');

    await expect(getRepoProjectRef('supabase', 'acme/site')).resolves.toBeNull();
    await expect(getRepoProjectRef('supabase', 'acme/api')).resolves.toBe('ref2');
  });

  it('recusa identificador de repositorio invalido', async () => {
    // A mesma guarda do resto do storage: chave torta viraria vinculo torto.
    await expect(getRepoProjectRef('supabase', 'sem-barra' as never)).rejects.toThrow();
  });
});
