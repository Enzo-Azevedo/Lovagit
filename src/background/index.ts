import { buildStatus, CHECK_INTERVAL_MINUTES, fetchLatestBuild } from '../lib/github/releases';

/**
 * Service worker. Deliberadamente magro: o loop do agente roda no documento do
 * side panel, que nao e' desligado pelo navegador no meio de uma requisicao —
 * ao contrario do service worker do MV3, que dorme apos ~30s ocioso.
 *
 * A excecao e' a procura por build novo. Ela precisa acontecer com a extensao
 * fechada, e um `setInterval` nao serve: o worker dorme e leva o timer junto.
 * `chrome.alarms` e' o unico relogio que sobrevive a isso — o navegador acorda
 * o worker na hora marcada.
 */

const ALARME_ATUALIZACAO = 'extension:check-update';

/**
 * Procura build novo e avisa pelo emblema do icone.
 *
 * O emblema existe porque uma consulta de fundo que nao aparece em lugar nenhum
 * nao serve para nada: com a extensao fechada, e' o unico lugar onde a novidade
 * cabe. Ele some sozinho na batida seguinte a instalacao da versao nova.
 */
async function procurarBuildNovo(): Promise<void> {
  try {
    const build = await fetchLatestBuild({ force: true });
    const temNovidade = buildStatus(build) === 'nova';

    await chrome.action.setBadgeText({ text: temNovidade ? '!' : '' });
    if (temNovidade) {
      await chrome.action.setBadgeBackgroundColor({ color: '#fe7b02' });
      await chrome.action.setTitle({ title: `Lovagit — build novo publicado (v${build.version})` });
    } else {
      await chrome.action.setTitle({ title: 'Abrir Lovagit' });
    }
  } catch {
    // Sem rede, GitHub fora do ar ou cota estourada. A proxima batida tenta de
    // novo; emblema de erro so assustaria por algo que nao e' do usuario nem
    // exige acao dele.
  }
}

/** Idempotente: `create` com o mesmo nome substitui o alarme que ja existia. */
function agendarProcura(): void {
  chrome.alarms.create(ALARME_ATUALIZACAO, { periodInMinutes: CHECK_INTERVAL_MINUTES });
}

function aoIniciar(): void {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  agendarProcura();
  // Uma consulta agora: o alarme so bate daqui a 30 minutos, e quem acabou de
  // instalar uma versao merece ver o emblema sumir na hora.
  void procurarBuildNovo();
}

chrome.runtime.onInstalled.addListener(aoIniciar);
chrome.runtime.onStartup.addListener(aoIniciar);

chrome.alarms.onAlarm.addListener((alarme) => {
  if (alarme.name === ALARME_ATUALIZACAO) void procurarBuildNovo();
});
