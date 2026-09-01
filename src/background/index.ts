/**
 * Service worker. Deliberadamente magro: o loop do agente roda no documento do
 * side panel, que nao e' desligado pelo navegador no meio de uma requisicao —
 * ao contrario do service worker do MV3, que dorme apos ~30s ocioso.
 */

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
