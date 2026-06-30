import type { RecordingState } from '@/lib/recording';
import { RuntimeMessageType } from '@/lib/messages';
import { resolveMicrophonePermissionState } from '@/lib/testing/permission-fixture';
import type { OffscreenClient } from './services/offscreen-client';
import { loadRecorderSettings, savePersistedContext } from './state/persisted-context';
import { delay } from './utils';
import { getTestActiveTabFixture } from './testing/control-plane';
import { isTestControlPlaneEnabled } from './testing/gate';
import type { RecordingSessionDeps } from './recording-session';

const ACTIVE_TAB_CAPTURE_STATUSES = ['pending', 'active'] as const;

/**
 * Builds the Chrome / OS-backed implementation of the recording session's dependency
 * port. This is the single place service-worker globals (chrome.*, navigator) are
 * touched; the aggregate stays browser-free.
 */
export function createPlatformDeps(offscreenClient: OffscreenClient): RecordingSessionDeps {
  return {
    offscreen: offscreenClient,
    delay,
    persist: (context) => savePersistedContext(context),
    broadcast: async (snapshot) => {
      try {
        await chrome.runtime.sendMessage({
          type: RuntimeMessageType.STATE_CHANGE,
          snapshot,
        });
      } catch {
        // Popup is usually closed; ignore.
      }
    },
    setBadge: (state) => updateBadge(state),
    showRecordingBanner: (tabId) => ensureRecordingBannerVisible(tabId),
    hideRecordingBanner: async (tabId) => {
      await sendRecordingBanner(tabId, false);
    },
    loadRecorderSettings,
    estimateStorage: () => navigator.storage.estimate(),
    resolveMicPermissionState: () => resolveMicrophonePermissionState(),
    isTestControlPlaneEnabled,
    getTestActiveTabFixture: () => getTestActiveTabFixture() as Promise<chrome.tabs.Tab | null>,
    queryActiveTab: async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return activeTab;
    },
    activateTab: async (tabId) => {
      await chrome.tabs.update(tabId, { active: true });
    },
    getCaptureStreamId: (tabId) => getTabCaptureStreamId(tabId),
    getCapturedTabInfo: (tabId) => getCapturedTabInfo(tabId),
    download: (options) => chrome.downloads.download(options),
  };
}

function updateBadge(next: RecordingState) {
  const badges: Partial<Record<RecordingState, { text: string; color: string }>> = {
    recording: { text: '●', color: '#FF3B30' },
    stopping: { text: '◐', color: '#FFD60A' },
    processing: { text: '◐', color: '#FFD60A' },
    error: { text: '!', color: '#FF9F0A' },
  };

  const badge = badges[next];
  if (badge) {
    chrome.action.setBadgeText({ text: badge.text });
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

async function sendRecordingBanner(tabId: number, visible: boolean) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: RuntimeMessageType.RECORDING_BANNER,
      visible,
    });
    return true;
  } catch {
    // Content script may be unavailable on browser-internal pages.
    return false;
  }
}

async function ensureRecordingBannerVisible(tabId: number) {
  const delivered = await sendRecordingBanner(tabId, true);
  if (delivered) return;

  try {
    // Content script is not active (e.g. extension was reloaded).
    // Inject the file to restore the message listener for future use,
    // then directly execute the overlay function to avoid the async
    // IIFE race where sendMessage fires before onMessage is registered.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/content.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const OVERLAY_ID = '__screen_recorder_recording_overlay__';
        const STYLE_ID = '__screen_recorder_recording_overlay_styles__';
        if (!document.documentElement || document.getElementById(OVERLAY_ID)) return;
        if (!document.getElementById(STYLE_ID)) {
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = `
            @keyframes jot-recording-breathe {
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
          (document.head ?? document.documentElement).appendChild(style);
        }
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = `
          position: fixed; inset: 0; pointer-events: none;
          z-index: 2147483647; border-radius: 0;
          box-shadow: inset 0 0 0 3px rgba(255, 59, 48, 0.85),
                      inset 0 0 20px rgba(255, 59, 48, 0.12);
          animation: jot-recording-breathe 2s ease-in-out infinite;
        `;
        (document.body ?? document.documentElement).appendChild(overlay);
      },
    });
  } catch {
    // Tab may still be navigating or disallow script injection.
  }
}

async function getTabCaptureStreamId(targetTabId: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(streamId);
    });
  });
}

async function getCapturedTabInfo(targetTabId: number): Promise<chrome.tabCapture.CaptureInfo | null> {
  if (typeof chrome.tabCapture.getCapturedTabs !== 'function') {
    return null;
  }

  const capturedTabs = await new Promise<chrome.tabCapture.CaptureInfo[]>((resolve, reject) => {
    chrome.tabCapture.getCapturedTabs((result) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(Array.isArray(result) ? result : []);
    });
  });

  return (
    capturedTabs.find(
      (item) =>
        item.tabId === targetTabId &&
        ACTIVE_TAB_CAPTURE_STATUSES.includes(item.status as (typeof ACTIVE_TAB_CAPTURE_STATUSES)[number]),
    ) ?? null
  );
}
