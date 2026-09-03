import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ISSUE_TARGET_REPO, LABELS } from '../telemetry/types';

/** Camada de rede mockada: os testes exercitam a politica, nao a API. */
interface IssueInput {
  title: string;
  body: string;
  labels: string[];
}

const issues = vi.hoisted(() => ({
  ensureLabels: vi.fn(async (_repo: string) => {}),
  createIssue: vi.fn(
    async (_repo: string, _input: { title: string; body: string; labels: string[] }) => ({
      number: 7,
      url: 'https://github.com/Enzo-Azevedo/Lovagit/issues/7',
      appliedLabels: ['Alta Prioridade', 'lovagit:erro-extensao'],
    }),
  ),
  findIssueByFingerprint: vi.fn(
    async (_repo: string, _fingerprint: string) =>
      null as { number: number; url: string; state: string } | null,
  ),
  commentOnIssue: vi.fn(
    async (_repo: string, _issueNumber: number, _body: string) =>
      'https://github.com/x/y/issues/7#c1',
  ),
  reopenIssue: vi.fn(async (_repo: string, _issueNumber: number) => {}),
  fingerprintMarker: (fingerprint: string) => `lovagit-fp:${fingerprint}`,
}));

/** Argumentos da chamada `n` de createIssue, ja tipados. */
function createIssueCall(index = 0): IssueInput {
  return issues.createIssue.mock.calls[index][1];
}
vi.mock('../telemetry/issues', () => issues);

const store = new Map<string, unknown>();
vi.stubGlobal('chrome', {
  runtime: { getManifest: () => ({ version: '0.2.0' }) },
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
      remove: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      },
    },
  },
});

type Reporter = typeof import('../telemetry/reporter');

interface Harness {
  reporter: Reporter;
  GitHubError: typeof import('../github/client').GitHubError;
  ProviderError: typeof import('../ai/types').ProviderError;
}

/**
 * `vi.resetModules()` zera o estado interno do reporter entre os testes, mas
 * tambem cria novas identidades de classe — as classes de erro precisam vir do
 * MESMO registro, senao o `instanceof` da classificacao nao casa.
 */
async function freshReporter(settings: Record<string, unknown> = {}): Promise<Harness> {
  vi.resetModules();
  store.clear();
  for (const mock of Object.values(issues)) {
    if (typeof mock === 'function' && 'mockClear' in mock) mock.mockClear();
  }
  issues.findIssueByFingerprint.mockResolvedValue(null);
  const [reporter, client, aiTypes] = await Promise.all([
    import('../telemetry/reporter'),
    import('../github/client'),
    import('../ai/types'),
  ]);
  if (Object.keys(settings).length > 0) await reporter.saveTelemetrySettings(settings);
  return { reporter, GitHubError: client.GitHubError, ProviderError: aiTypes.ProviderError };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Sem isso, timers de um teste sobrevivem ao proximo e disparam dispatch de
  // instancias antigas do modulo.
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('captureError — defeitos viram issue', () => {
  it('abre issue com Alta Prioridade depois da janela de desfazer', async () => {
    const { reporter } = await freshReporter();
    await reporter.captureError(new TypeError('x.map nao e funcao'), { module: 'agent/loop' });

    expect(issues.createIssue).not.toHaveBeenCalled(); // ainda da para cancelar

    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.ensureLabels).toHaveBeenCalledOnce();
    expect(issues.createIssue).toHaveBeenCalledOnce();
    const input = createIssueCall();
    expect(input.labels).toEqual([LABELS.highPriority, LABELS.extensionError]);
    expect(input.title).toContain('[extensao]');
    expect(input.body).toContain('lovagit-fp:');
    expect(input.body).toContain('**Alta**');

    const log = await reporter.getReportLog();
    expect(log[0]).toMatchObject({ status: 'reportado', issueNumber: 7 });
  });

  it('erro de integracao entra sem Alta Prioridade', async () => {
    const { reporter, ProviderError } = await freshReporter();
    await reporter.captureError(new ProviderError('resposta sem choices', 'protocol'), {
      module: 'ai/openai-compatible',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(createIssueCall().labels).toEqual([LABELS.integrationError]);
  });
});

describe('captureError — o que nao vira issue', () => {
  it('erro de configuracao do usuario fica so no log local', async () => {
    const { reporter, GitHubError } = await freshReporter();
    await reporter.captureError(new GitHubError('Bad credentials', 401, '/user'), {
      module: 'github/client',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue).not.toHaveBeenCalled();
    expect((await reporter.getReportLog())[0].status).toBe('ignorado');
  });

  // Regressao da issue #5: essa falha abriu um issue de Alta Prioridade em uso
  // real, quando deveria ter ficado apenas na interface.
  it('queda de conexao no meio do stream nao abre issue', async () => {
    const { reporter } = await freshReporter();
    await reporter.captureError(new TypeError('network error'), {
      module: 'sidepanel/ChatView',
      repoId: 'acme/site',
      providerKind: 'openai-compatible',
      step: 'conversa',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue).not.toHaveBeenCalled();
    expect((await reporter.getReportLog())[0].status).toBe('ignorado');
  });

  it('cancelamento do usuario e ignorado por completo', async () => {
    const { reporter } = await freshReporter();
    await reporter.captureError(new DOMException('cancelado', 'AbortError'), { module: 'agent/loop' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue).not.toHaveBeenCalled();
    expect(await reporter.getReportLog()).toHaveLength(0);
  });

  it('cancelar dentro da janela impede o envio', async () => {
    const { reporter } = await freshReporter();
    await reporter.captureError(new TypeError('falha'), { module: 'agent/loop' });

    const pendingId = await new Promise<string>((resolve) => {
      const unsubscribe = reporter.subscribeTelemetry((snapshot) => {
        if (snapshot.pending[0]) {
          unsubscribe();
          resolve(snapshot.pending[0].id);
        }
      });
    });
    reporter.cancelPendingReport(pendingId);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue).not.toHaveBeenCalled();
    expect((await reporter.getReportLog())[0].status).toBe('cancelado');
  });

  it('respeita o desligamento nas configuracoes', async () => {
    const { reporter } = await freshReporter({ enabled: false });
    await reporter.captureError(new TypeError('falha'), { module: 'agent/loop' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue).not.toHaveBeenCalled();
    expect((await reporter.getReportLog())[0].status).toBe('suprimido');
  });
});

describe('captureError — controle de volume', () => {
  it('agrupa ocorrencias identicas na mesma janela em um unico issue', async () => {
    const { reporter } = await freshReporter();
    await reporter.captureError(new TypeError('mesma falha'), { module: 'agent/loop' });
    await reporter.captureError(new TypeError('mesma falha'), { module: 'agent/loop' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue).toHaveBeenCalledOnce();
    expect(createIssueCall().body).toContain('| Ocorrencias ate o envio | 2 |');
  });

  it('reincidencia dentro de 1h nem chega a fazer requisicao', async () => {
    const { reporter } = await freshReporter();
    await reporter.captureError(new TypeError('falha recorrente'), { module: 'agent/loop' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(issues.createIssue).toHaveBeenCalledOnce();

    await reporter.captureError(new TypeError('falha recorrente'), { module: 'agent/loop' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue).toHaveBeenCalledOnce();
    expect(issues.commentOnIssue).not.toHaveBeenCalled();
    expect((await reporter.getReportLog())[0]).toMatchObject({ status: 'agrupado', issueNumber: 7 });
  });

  it('comenta no issue existente em vez de abrir outro quando ja existe no repositorio', async () => {
    const { reporter } = await freshReporter();
    issues.findIssueByFingerprint.mockResolvedValue({
      number: 42,
      url: 'https://github.com/Enzo-Azevedo/Lovagit/issues/42',
      state: 'closed',
    });

    await reporter.captureError(new TypeError('falha ja conhecida'), { module: 'agent/loop' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue).not.toHaveBeenCalled();
    expect(issues.reopenIssue).toHaveBeenCalledWith('Enzo-Azevedo/Lovagit', 42);
    expect(issues.commentOnIssue).toHaveBeenCalledOnce();
    expect((await reporter.getReportLog())[0]).toMatchObject({ status: 'agrupado', issueNumber: 42 });
  });

  it('respeita o teto de issues novos por hora', async () => {
    const { reporter } = await freshReporter({ maxIssuesPerHour: 1 });
    await reporter.captureError(new TypeError('primeira falha'), { module: 'agent/loop' });
    await vi.advanceTimersByTimeAsync(10_000);
    await reporter.captureError(new RangeError('segunda falha diferente'), { module: 'github/writer' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue).toHaveBeenCalledOnce();
    expect((await reporter.getReportLog())[0]).toMatchObject({ status: 'suprimido' });
  });
});

describe('captureError — robustez', () => {
  it('falha de envio nao propaga e fica registrada', async () => {
    const { reporter } = await freshReporter();
    issues.createIssue.mockRejectedValueOnce(new Error('403 sem permissao de issues'));

    await reporter.captureError(new TypeError('falha'), { module: 'agent/loop' });
    await expect(vi.advanceTimersByTimeAsync(10_000)).resolves.not.toThrow();

    expect((await reporter.getReportLog())[0]).toMatchObject({ status: 'falhou' });
  });

  it('redige o contexto antes de montar o relatorio', async () => {
    const { reporter } = await freshReporter();
    store.set('settings', { connectedRepoIds: ['acme/projeto-secreto'] });

    await reporter.captureError(new TypeError('quebrou em acme/projeto-secreto'), {
      module: 'agent/tools',
      repoId: 'acme/projeto-secreto',
      path: 'src/components/Segredo.tsx',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    const input = createIssueCall();
    expect(input.body).not.toContain('projeto-secreto');
    expect(input.title).not.toContain('projeto-secreto');
    expect(input.body).toContain('<arquivo .tsx>');
    expect(input.body).toContain('repo#');
  });
});

describe('fila persistida', () => {
  it('retoma e envia relatorio que ficou pendente de uma sessao anterior', async () => {
    const first = await freshReporter();
    await first.reporter.captureError(new TypeError('falha antes de fechar o painel'), {
      module: 'agent/loop',
    });
    expect(issues.createIssue).not.toHaveBeenCalled();

    // Simula o painel fechando: os timers da pagina morrem com ela e o modulo e'
    // recarregado do zero — so o storage atravessa.
    vi.clearAllTimers();
    vi.resetModules();
    issues.createIssue.mockClear();
    const reloaded = await import('../telemetry/reporter');

    await reloaded.resumePendingReports();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue).toHaveBeenCalledOnce();
    expect((await reloaded.getReportLog())[0].status).toBe('reportado');
  });

  it('cancelar tambem tira da fila persistida', async () => {
    const { reporter } = await freshReporter();
    await reporter.captureError(new TypeError('vai ser cancelado'), { module: 'agent/loop' });
    const pendingId = await new Promise<string>((resolve) => {
      const unsubscribe = reporter.subscribeTelemetry((snapshot) => {
        if (snapshot.pending[0]) {
          unsubscribe();
          resolve(snapshot.pending[0].id);
        }
      });
    });
    reporter.cancelPendingReport(pendingId);
    await vi.advanceTimersByTimeAsync(50);

    expect(store.get('telemetry:pending')).toEqual({});
  });
});

describe('destino do issue', () => {
  it('e sempre o repositorio da extensao, e nao um campo que da para trocar', async () => {
    // Como configuracao editavel isso so oferecia formas de quebrar: um
    // repositorio onde o PAT nao tem `Issues: write` faz todo relato falhar em
    // silencio, e um repositorio de terceiro receberia stack trace e caminho de
    // arquivo de quem usa a extensao.
    const { reporter } = await freshReporter();
    await reporter.captureError(new TypeError('destino fixo'), { module: 'agent/loop' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.ensureLabels).toHaveBeenCalledWith(ISSUE_TARGET_REPO);
    expect(issues.createIssue.mock.calls[0][0]).toBe(ISSUE_TARGET_REPO);
  });

  it('ignora um `targetRepoId` que tenha sobrado de versao antiga no storage', async () => {
    // Quem ja usava a extensao tem a chave gravada. Ela nao pode voltar a
    // mandar relato para outro lugar so por continuar la.
    const { reporter } = await freshReporter({ targetRepoId: 'terceiro/projeto' });
    await reporter.captureError(new TypeError('storage antigo'), { module: 'agent/loop' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(issues.createIssue.mock.calls[0][0]).toBe(ISSUE_TARGET_REPO);
  });
});
