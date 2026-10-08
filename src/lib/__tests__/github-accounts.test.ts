import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Cofre em memoria: o de verdade usa IndexedDB e WebCrypto. */
const cofre = vi.hoisted(() => {
  const dados = new Map<string, string>();
  return {
    dados,
    SecretNames: {
      githubPat: 'github_pat',
      githubPatAccount: (id: string) => `github_pat:${id}`,
    },
    setSecret: vi.fn(async (nome: string, valor: string) => {
      dados.set(nome, valor);
    }),
    deleteSecret: vi.fn(async (nome: string) => {
      dados.delete(nome);
    }),
  };
});
vi.mock('../vault', () => cofre);

/** Settings em memoria, com o mesmo formato raso usado pelas funcoes. */
const armazem = vi.hoisted(() => {
  let settings = {
    githubAccounts: [] as { id: string; login: string; avatarUrl: string }[],
    activeGitHubAccountId: null as string | null,
    githubUser: null as { login: string; avatarUrl: string } | null,
  };
  return {
    definirSettings: (next: unknown) => {
      settings = next as typeof settings;
    },
    settings: () => settings,
    getSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async (patch: typeof settings) => {
      settings = { ...settings, ...patch };
      return settings;
    }),
  };
});
vi.mock('../storage', () => ({
  getSettings: armazem.getSettings,
  saveSettings: armazem.saveSettings,
}));

const cliente = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
}));
vi.mock('../github/client', () => cliente);

const {
  addGitHubAccount,
  removeGitHubAccount,
  setActiveGitHubAccount,
  activateAccountForRepoOwner,
} = await import('../github/accounts');

function usuario(login: string) {
  return { login, avatarUrl: `https://github.com/${login}.png`, name: null };
}

beforeEach(() => {
  cofre.dados.clear();
  cliente.getAuthenticatedUser.mockReset();
  armazem.saveSettings.mockClear();
  armazem.definirSettings({ githubAccounts: [], activeGitHubAccountId: null, githubUser: null });
});

describe('addGitHubAccount', () => {
  it('valida o token colado, grava no cofre e ativa a conta', async () => {
    cliente.getAuthenticatedUser.mockResolvedValue(usuario('fulano'));

    const conta = await addGitHubAccount('  ghp_abc123  ');

    expect(cliente.getAuthenticatedUser).toHaveBeenCalledWith('ghp_abc123');
    expect(cofre.dados.get(`github_pat:${conta.id}`)).toBe('ghp_abc123');
    expect(armazem.settings()).toEqual({
      githubAccounts: [conta],
      activeGitHubAccountId: conta.id,
      githubUser: { login: 'fulano', avatarUrl: 'https://github.com/fulano.png' },
    });
  });

  it('rejeita token em branco sem chamar a API', async () => {
    await expect(addGitHubAccount('   ')).rejects.toThrow(/Informe o token/);
    expect(cliente.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('reusa a conta de mesmo login em vez de duplicar', async () => {
    const existente = { id: 'conta-1', login: 'fulano', avatarUrl: '' };
    armazem.definirSettings({
      githubAccounts: [existente],
      activeGitHubAccountId: 'conta-1',
      githubUser: { login: 'fulano', avatarUrl: '' },
    });
    cliente.getAuthenticatedUser.mockResolvedValue(usuario('fulano'));

    const conta = await addGitHubAccount('ghp_novo');

    expect(conta.id).toBe('conta-1');
    expect(cofre.dados.get('github_pat:conta-1')).toBe('ghp_novo');
    expect(armazem.settings().githubAccounts).toHaveLength(1);
  });

  it('apaga o token legado depois de cadastrar a conta', async () => {
    cofre.dados.set('github_pat', 'ghp_legado');
    cliente.getAuthenticatedUser.mockResolvedValue(usuario('beltrano'));

    await addGitHubAccount('ghp_novo');

    expect(cofre.dados.has('github_pat')).toBe(false);
  });
});

describe('removeGitHubAccount', () => {
  it('remove a conta, apaga o token e elege outra ativa', async () => {
    const a = { id: 'a', login: 'ana', avatarUrl: '' };
    const b = { id: 'b', login: 'bia', avatarUrl: '' };
    armazem.definirSettings({
      githubAccounts: [a, b],
      activeGitHubAccountId: 'a',
      githubUser: { login: 'ana', avatarUrl: '' },
    });
    cofre.dados.set('github_pat:a', 'ghp_a');
    cofre.dados.set('github_pat:b', 'ghp_b');

    await removeGitHubAccount('a');

    expect(cofre.dados.has('github_pat:a')).toBe(false);
    expect(armazem.settings().githubAccounts).toEqual([b]);
    expect(armazem.settings().activeGitHubAccountId).toBe('b');
    expect(armazem.settings().githubUser).toEqual({ login: 'bia', avatarUrl: '' });
  });

  it('zera githubUser quando remove a unica conta', async () => {
    const a = { id: 'a', login: 'ana', avatarUrl: '' };
    armazem.definirSettings({
      githubAccounts: [a],
      activeGitHubAccountId: 'a',
      githubUser: { login: 'ana', avatarUrl: '' },
    });

    await removeGitHubAccount('a');

    expect(armazem.settings().githubAccounts).toEqual([]);
    expect(armazem.settings().activeGitHubAccountId).toBeNull();
    expect(armazem.settings().githubUser).toBeNull();
  });
});

describe('setActiveGitHubAccount', () => {
  it('troca a ativa e atualiza githubUser', async () => {
    const a = { id: 'a', login: 'ana', avatarUrl: '' };
    const b = { id: 'b', login: 'bia', avatarUrl: '' };
    armazem.definirSettings({
      githubAccounts: [a, b],
      activeGitHubAccountId: 'a',
      githubUser: { login: 'ana', avatarUrl: '' },
    });

    await setActiveGitHubAccount('b');

    expect(armazem.settings().activeGitHubAccountId).toBe('b');
    expect(armazem.settings().githubUser).toEqual({ login: 'bia', avatarUrl: '' });
  });

  it('ignora id que nao existe', async () => {
    const a = { id: 'a', login: 'ana', avatarUrl: '' };
    armazem.definirSettings({
      githubAccounts: [a],
      activeGitHubAccountId: 'a',
      githubUser: { login: 'ana', avatarUrl: '' },
    });

    await setActiveGitHubAccount('nao-existe');

    expect(armazem.settings().activeGitHubAccountId).toBe('a');
  });
});

describe('activateAccountForRepoOwner', () => {
  it('ativa a conta cujo login casa com o owner do repositorio', async () => {
    const a = { id: 'a', login: 'ana', avatarUrl: '' };
    const b = { id: 'b', login: 'bia', avatarUrl: '' };
    armazem.definirSettings({
      githubAccounts: [a, b],
      activeGitHubAccountId: 'a',
      githubUser: { login: 'ana', avatarUrl: '' },
    });

    await activateAccountForRepoOwner('Bia');

    expect(armazem.settings().activeGitHubAccountId).toBe('b');
    expect(armazem.settings().githubUser).toEqual({ login: 'bia', avatarUrl: '' });
  });

  it('nao grava nada quando a conta do owner ja esta ativa', async () => {
    const a = { id: 'a', login: 'ana', avatarUrl: '' };
    armazem.definirSettings({
      githubAccounts: [a],
      activeGitHubAccountId: 'a',
      githubUser: { login: 'ana', avatarUrl: '' },
    });

    await activateAccountForRepoOwner('ANA');

    expect(armazem.saveSettings).not.toHaveBeenCalled();
    expect(armazem.settings().activeGitHubAccountId).toBe('a');
  });

  it('nao mexe quando nenhum login casa (repositorio de organizacao)', async () => {
    const a = { id: 'a', login: 'ana', avatarUrl: '' };
    armazem.definirSettings({
      githubAccounts: [a],
      activeGitHubAccountId: 'a',
      githubUser: { login: 'ana', avatarUrl: '' },
    });

    await activateAccountForRepoOwner('acme-corp');

    expect(armazem.saveSettings).not.toHaveBeenCalled();
    expect(armazem.settings().activeGitHubAccountId).toBe('a');
  });
});
