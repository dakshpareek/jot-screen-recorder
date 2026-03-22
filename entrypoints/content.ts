const OVERLAY_ID = '__screen_recorder_recording_overlay__';
const STYLE_ID = '__screen_recorder_recording_overlay_styles__';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'RECORDING_BANNER') return;
      if (message.visible) {
        showOverlay();
      } else {
        hideOverlay();
      }
    });
  },
});

function showOverlay() {
  if (!document.documentElement) return;
  if (document.getElementById(OVERLAY_ID)) return;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes rk-recording-breathe {
        0%, 100% {
          box-shadow:
            inset 0 0 0 3px rgba(255, 59, 48, 0.85),
            inset 0 0 16px rgba(255, 59, 48, 0.12);
        }
        50% {
          box-shadow:
            inset 0 0 0 3px rgba(255, 59, 48, 0.45),
            inset 0 0 28px rgba(255, 59, 48, 0.18);
        }
      }
    `;
    const styleParent = document.head ?? document.documentElement;
    styleParent.appendChild(style);
  }

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483647;
    border-radius: 0;
    box-shadow:
      inset 0 0 0 3px rgba(255, 59, 48, 0.85),
      inset 0 0 20px rgba(255, 59, 48, 0.12);
    animation: rk-recording-breathe 2s ease-in-out infinite;
  `;

  const parent = document.body ?? document.documentElement;
  parent.appendChild(overlay);
}

function hideOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
}
