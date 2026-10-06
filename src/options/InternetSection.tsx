import { useCallback, useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../lib/storage';

/**
 * Internet no agente (bloco 9).
 *
 * As opcoes ja viviam em `settings.internetAccess` desde a camada de dados; o
 * que faltava era a tela para liga-las — sem ela, a busca web existia no codigo
 * mas nao dava para ativar nem para restringir a duvida severa.
 */
export function InternetSection() {
  const [enabled, setEnabled] = useState(false);
  const [onlyWhenStuck, setOnlyWhenStuck] = useState(false);

  const reload = useCallback(async () => {
    const settings = await getSettings();
    setEnabled(settings.internetAccess.enabled);
    setOnlyWhenStuck(settings.internetAccess.onlyWhenStuck);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const updateEnabled = useCallback(
    async (value: boolean) => {
      setEnabled(value);
      await saveSettings({ internetAccess: { enabled: value, onlyWhenStuck } });
      await reload();
    },
    [onlyWhenStuck, reload],
  );

  const updateOnlyWhenStuck = useCallback(
    async (value: boolean) => {
      setOnlyWhenStuck(value);
      await saveSettings({ internetAccess: { enabled, onlyWhenStuck: value } });
      await reload();
    },
    [enabled, reload],
  );

  return (
    <section className="space-y-3 rounded-lg border border-ink-700 bg-ink-900 p-4">
      <h2 className="text-sm text-ink-200">9. Internet no agente</h2>
      <p className="text-xs text-ink-400">
        Ligando, o agente ganha a ferramenta <code>web_search</code>, que pesquisa na web pelo
        DuckDuckGo — o unico caminho gratuito que nao exige chave nem conta. A busca devolve
        resumo de verbete, nao uma varredura completa da web: pergunta muito recente ou obscura
        pode voltar vazia.
      </p>
      <p className="text-xs text-ink-400">
        Serve para fatos que <strong>nao estao neste repositorio</strong> e que o modelo nao tem
        como saber — definicao de termo, sintaxe de biblioteca, versao atual de ferramenta. Para
        ler o proprio repositorio, <code>read_file</code> e <code>search_code</code> continuam
        sendo o caminho: sao mais precisos e nao saem da maquina.
      </p>

      <label className="flex items-start gap-2 text-xs text-ink-200">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enabled}
          onChange={(event) => void updateEnabled(event.target.checked)}
        />
        <span>
          Ligar busca na web
          <span className="mt-1 block text-[11px] text-ink-400">
            Desligada por padrao. Sem isto, a ferramenta <code>web_search</code> nem aparece no
            prompt do agente.
          </span>
        </span>
      </label>

      <label
        className={`flex items-start gap-2 text-xs ${enabled ? 'text-ink-200' : 'text-ink-600'}`}
      >
        <input
          type="checkbox"
          className="mt-0.5"
          disabled={!enabled}
          checked={onlyWhenStuck}
          onChange={(event) => void updateOnlyWhenStuck(event.target.checked)}
        />
        <span>
          Somente sob duvida severa
          <span className="mt-1 block text-[11px] text-ink-400">
            Exige que o modelo explique, no campo <code>reason</code>, a duvida concreta que a
            pesquisa resolve. Nao e so pedido no prompt: a extensao <strong>recusa na execucao</strong>{' '}
            justificativa vazia, curta demais ou generica ("para confirmar"). Pesquisar para
            confirmar o que ele ja sabe e desperdicio e e barrado.
          </span>
        </span>
      </label>
    </section>
  );
}
