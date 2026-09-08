import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Cofre em memoria: o de verdade usa IndexedDB e WebCrypto. */
const cofre = vi.hoisted(() => {
  const dados = new Map<string, string>();
  return {
    dados,
    SecretNames: { mcpToken: (id: string) => `mcp:${id}:token` },
    setSecret: vi.fn(async (nome: string, valor: string) => {
      dados.set(nome, valor);
    }),
    getSecret: vi.fn(async (nome: string) => dados.get(nome) ?? null),
    deleteSecret: vi.fn(async (nome: string) => {
      dados.delete(nome);
    }),
  };
});
vi.mock('../vault', () => cofre);

const { clearServerToken, getServerToken, setServerToken } = await import('../mcp/token');

beforeEach(() => cofre.dados.clear());

describe('token colado a mao', () => {
  it('guarda o token e devolve o mesmo de volta', async () => {
    await expect(setServerToken('srv1', 'sbp_1234')).resolves.toBe(true);
    await expect(getServerToken('srv1')).resolves.toBe('sbp_1234');
  });

  it('apara espacos de quem colou com sobra', async () => {
    // Copiar do painel do provedor costuma trazer espaco ou quebra de linha.
    await setServerToken('srv1', '  sbp_1234\n');
    await expect(getServerToken('srv1')).resolves.toBe('sbp_1234');
  });

  it('token so de espacos e o mesmo que token nenhum', async () => {
    // `Bearer   ` faz o servidor responder um 401 falando de credencial
    // ausente — mesmo defeito que ja mordeu na chave do provedor de IA.
    await expect(setServerToken('srv1', '   ')).resolves.toBe(false);
    await expect(getServerToken('srv1')).resolves.toBeNull();
  });

  it('salvar vazio apaga o que estava guardado', async () => {
    await setServerToken('srv1', 'sbp_1234');
    await expect(setServerToken('srv1', '')).resolves.toBe(false);
    await expect(getServerToken('srv1')).resolves.toBeNull();
  });

  it('cada servidor tem o seu — um nao enxerga o token do outro', async () => {
    await setServerToken('srv1', 'sbp_um');
    await setServerToken('srv2', 'sbp_dois');
    await expect(getServerToken('srv1')).resolves.toBe('sbp_um');

    await clearServerToken('srv1');
    expect(await getServerToken('srv1')).toBeNull();
    expect(await getServerToken('srv2')).toBe('sbp_dois');
  });
});
