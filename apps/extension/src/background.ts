import { registerNetworkMediaCapture } from './networkMediaCapture';

function configureSidePanel(): void {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'XUNLEI_ZHIQU_OPEN_PANEL' || !sender.tab?.id) return false;

  void chrome.sidePanel.open({ tabId: sender.tab.id })
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: detail });
    });
  return true;
});

registerNetworkMediaCapture();
