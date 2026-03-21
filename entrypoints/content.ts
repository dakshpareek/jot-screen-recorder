const BANNER_ID = '__screen_recorder_recording_banner__';
const BANNER_TEXT = "Recording in progress - do not close this tab. Tab audio is being captured (you won't hear it)";

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'RECORDING_BANNER') return;
      if (message.visible) {
        showBanner();
      } else {
        hideBanner();
      }
    });
  },
});

function showBanner() {
  if (!document.documentElement) return;
  if (document.getElementById(BANNER_ID)) return;

  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.textContent = BANNER_TEXT;
  banner.style.position = 'fixed';
  banner.style.top = '12px';
  banner.style.left = '50%';
  banner.style.transform = 'translateX(-50%)';
  banner.style.padding = '8px 12px';
  banner.style.background = '#ff3b30';
  banner.style.color = '#fff';
  banner.style.fontSize = '13px';
  banner.style.fontWeight = '600';
  banner.style.fontFamily = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  banner.style.borderRadius = '999px';
  banner.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.25)';
  banner.style.zIndex = '2147483647';
  banner.style.pointerEvents = 'none';

  const parent = document.body ?? document.documentElement;
  parent.appendChild(banner);
}

function hideBanner() {
  document.getElementById(BANNER_ID)?.remove();
}
