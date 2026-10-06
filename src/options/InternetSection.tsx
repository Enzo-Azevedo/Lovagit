import { useCallback, useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../lib/storage';
import { hasWebSearchPermission, requestWebSearchPermission } from '../lib/web/search';

/**
 * Internet no agente (bloco 9).
 *
 * As opcoes ja viviam em `settings.internetAccess` desde a camada de dados; o
 * que faltava era a tela para liga-las — sem ela, a busca web existia no codigo
 * mas nao dava para ativar nem para restringir a duvida severa.
 *
 * A busca fala com o DuckDuckGo (`api.duckduckgo.com` e `html.duckduckgo.com`),
 * que nao esta no `host_permissions` fixo. Por isso ligar a opcao tambem pede a
 * permissao de host — e esse pedido precisa ser a PRIMEIRA operacao assincrona
 * do clique. Sem isso, toda busca falhava antes de sair da maquina.
 */
export function InternetSection() {
  const [enabled, setEnabled] = useState(false);
  const [onlyWhenStuck, setOnlyWhenStuck] = useState(false);
  /** Ligada mas sem permissao de host: toda busca falharia. */
  const [semPermissao, setSemPermissao] = useState(false);

  const reload = useCallback(async () => {
    const settings = await getSettings();
    setEnabled(settings.internetAccess.enabled);
    setOnlyWhenStuck(settings.internetAccess.onlyWhenStuck);
    // Uma instalacao anterior pode ter gravado `enabled` sem a permissao (ela
    // nao era pedida). Nao da para pedir aqui — fora de um clique o Chrome
    // recusa — entao so avisamos para o usuario re-marcar e autorizar.
    setSemPermissao(settings.internetAccess.enabled && !(await hasWebSearchPermission()));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const updateEnabled = useCallback(
    async (value: boolean) => {
      if (value) {
        // Primeira operacao assincrona do clique. Qualquer await antes deste
        // pedido encerraria o gesto e o Chrome recusaria sem mostrar dialogo.
        const granted = await requestWebSearchPermission();
        if (!granted) {
          setSemPermissao(true);
          return;
        }
      }
      setSemPermissao(false);
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
        DuckDuckGo — o único caminho gratuito que não exige chave nem conta. A busca devolve o
        resumo do verbete (quando existe) e, quando não, títulos, trechos e links de resultados.
        Não é uma varredura completa da web: pergunta muito recente ou obscura pode voltar vazia.
      </p>
      <p className="text-xs text-ink-400">
        Serve para fatos que <strong>não estão neste repositório</strong> e que o modelo não tem
        como saber — definição de termo, sintaxe de biblioteca, versão atual de ferramenta. Para
        ler o próprio repositório, <code>read_file</code> e <code>search_code</code> continuam
        sendo o caminho: são mais precisos e não saem da máquina.
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
            Desligada por padrão. Sem isto, a ferramenta <code>web_search</code> nem aparece no
            prompt do agente. Ao ligar, o navegador pede permissão para acessar{' '}
            <code>duckduckgo.com</code>.
          </span>
        </span>
      </label>

      {semPermissao && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300">
          Sem permissão para acessar o DuckDuckGo — toda busca na web falharia. Marque{' '}
          <strong>Ligar busca na web</strong> de novo para o navegador pedir a permissão.
        </p>
      )}

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
          Somente sob dúvida severa
          <span className="mt-1 block text-[11px] text-ink-400">
            Exige que o modelo explique, no campo <code>reason</code>, a dúvida concreta que a
            pesquisa resolve. Não é só pedido no prompt: a extensão{' '}
            <strong>recusa na execução</strong>{' '}
            justificativa vazia, curta demais ou genérica ("para confirmar"). Pesquisar para
            confirmar o que ele já sabe é desperdício e é barrado.
          </span>
        </span>
      </label>
    </section>
  );
}
