import type { RecordingState } from '@/lib/recording';
import type {
  CaptureQuality,
  MicMixFailedMessage,
  OffscreenEventMessage,
  StorageSignalMessage,
  SystemAudioSignalMessage,
} from '@/lib/messages';
import { RuntimeMessageType } from '@/lib/messages';
import { MessageRouter } from '@/lib/message-router';
import { debugWarn } from '@/lib/runtime-log';
import { OffscreenClient } from './background/services/offscreen-client';
import {
  loadPersistedContext,
  savePersistedContext,
  loadRecorderSettings,
  saveRecorderSettings,
  type RecorderSettings,
} from './background/state/persisted-context';
import {
  delay,
  normalizeAudioSource,
  normalizeCaptureQuality,
  normalizeMicDeviceId,
  toErrorMessage,
} from './background/utils';
import { resolveMicrophonePermissionState } from '@/lib/testing/permission-fixture';
import {
  getTestActiveTabFixture,
  handleTestControlPlaneMessage,
  installTestControlPlaneDebugHook,
  installTestControlPlaneRuntimeHandlers,
} from './background/testing/control-plane';
import { isTestControlPlaneEnabled } from './background/testing/gate';
import { RecordingSession, type RecordingSessionDeps } from './background/recording-session';

const ACTIVE_TAB_CAPTURE_STATUSES = ['pending', 'active'] as const;

const offscreenClient = new OffscreenClient();

const deps: RecordingSessionDeps = {
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
  getTestActiveTabFixture: () =>
    getTestActiveTabFixture() as Promise<chrome.tabs.Tab | null>,
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

const session = new RecordingSession(deps);

export default defineBackground(() => {
  installTestControlPlaneDebugHook(
    () => session.snapshot(),
    () => session.outputFileName,
  );
  installTestControlPlaneRuntimeHandlers({
    prepareStart: (includeMic, micDeviceId, quality) =>
      session.prepareStart(includeMic, micDeviceId, quality),
    start: (audioSource, micDeviceId, quality) => session.start(audioSource, micDeviceId, quality),
    stop: () => session.stop(),
    refreshOrphans: () => session.refreshOrphans(),
    recoverOrphan: (sessionId, chunkIndexes) => session.recoverOrphan(sessionId, chunkIndexes),
    discardOrphan: (sessionId) => session.discardOrphan(sessionId),
    syncOrphanFixture: (previousFixture, nextFixture) =>
      session.syncOrphanFixture(previousFixture, nextFixture),
  });

  const router = new MessageRouter();

  router
    .onMatch(
      (type) => type.startsWith('TEST_'),
      (message) =>
        handleTestControlPlaneMessage(message, () => session.snapshot(), () => session.outputFileName),
    )
    .on(RuntimeMessageType.GET_STATE, () => session.snapshot())
    .on(RuntimeMessageType.START, (message) =>
      session.start(
        normalizeAudioSource(message.audioSource),
        normalizeMicDeviceId(message.micDeviceId),
        normalizeCaptureQuality(message.quality),
      ),
    )
    .on(RuntimeMessageType.PREPARE_START, (message) =>
      session.prepareStart(
        message.includeMic !== false,
        normalizeMicDeviceId(message.micDeviceId),
        normalizeCaptureQuality(message.quality),
      ),
    )
    .on(RuntimeMessageType.RUN_MIC_CHECK, (message) =>
      session.runMicCheck(normalizeMicDeviceId(message.micDeviceId)),
    )
    .on(RuntimeMessageType.RELEASE_MIC_CHECK, () => session.releaseMicCheck())
    .on(RuntimeMessageType.CANCEL_START, () => session.cancelStart())
    .on(RuntimeMessageType.STOP, () => session.stop())
    .on(RuntimeMessageType.DOWNLOAD, () => session.download())
    .on(RuntimeMessageType.RESET_TO_IDLE, () => session.resetToIdle())
    .on(RuntimeMessageType.DOWNLOAD_RAW_CHUNKS, (message) =>
      session.downloadRawChunks(String(message.sessionId ?? '')),
    )
    .on(RuntimeMessageType.RECOVER_ORPHAN, (message) => {
      const chunkIndexes = Array.isArray(message.chunkIndexes)
        ? message.chunkIndexes
            .map((value: unknown) => Number(value))
            .filter((value: number) => Number.isInteger(value) && value >= 0)
        : undefined;
      return session.recoverOrphan(String(message.sessionId ?? ''), chunkIndexes);
    })
    .on(RuntimeMessageType.DISCARD_ORPHAN, (message) =>
      session.discardOrphan(String(message.sessionId ?? '')),
    )
    .on(RuntimeMessageType.REFRESH_ORPHANS, () => session.refreshOrphans())
    .on(RuntimeMessageType.OPEN_MIC_SETTINGS, () => handleOpenMicSettings())
    .on(RuntimeMessageType.OFFSCREEN_EVENT, (message) =>
      session.applyOffscreenEvent(message as OffscreenEventMessage),
    )
    .on(RuntimeMessageType.MIC_MIX_FAILED, (message) =>
      session.applyMicMixFailed(message as MicMixFailedMessage),
    )
    .on(
      [
        RuntimeMessageType.SYSTEM_AUDIO_OK,
        RuntimeMessageType.SYSTEM_AUDIO_SILENT,
        RuntimeMessageType.SYSTEM_AUDIO_ABSENT,
      ],
      (message) => session.applySystemAudioSignal(message as SystemAudioSignalMessage),
    )
    .on(
      [RuntimeMessageType.LOW_STORAGE_WARNING, RuntimeMessageType.AUTO_STOP_LOW_STORAGE],
      (message) => session.applyStorageSignal(message as StorageSignalMessage),
    )
    .on(RuntimeMessageType.WEBCODECS_FATAL_ERROR, (message) =>
      session.handleWebCodecsFatalError(message.error as string | undefined),
    )
    .on(RuntimeMessageType.OFFSCREEN_READY, () => {
      offscreenClient.markReady();
      return { ok: true };
    })
    .on(RuntimeMessageType.GET_ENCODER_SETTINGS, () => loadRecorderSettings())
    .on(RuntimeMessageType.SET_ENCODER_SETTINGS, (message) =>
      saveRecorderSettings(message.settings as Partial<RecorderSettings>),
    )
    .on(RuntimeMessageType.WEBCODECS_CHECK_SUPPORT, (message) =>
      handleWebCodecsCheckSupport(message.quality as CaptureQuality | undefined),
    );

  chrome.runtime.onMessage.addListener(router.dispatch);

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    void session.onRecordingTabUpdated(tabId, changeInfo);
  });
  chrome.runtime.onInstalled.addListener(() => {
    void session.refreshOrphanedSessions();
  });

  void bootstrap();
});

async function bootstrap() {
  await hydrateContext();
  await session.reconcileWithOffscreen();
  await session.refreshOrphanedSessions();
  await deps.broadcast(session.snapshot());
}

async function hydrateContext() {
  try {
    const stored = await loadPersistedContext();
    if (!stored) return;
    session.hydrate(stored);
  } catch (error) {
    console.error('Failed to hydrate context', error);
    session.failHydration(error);
  }
}

async function handleOpenMicSettings() {
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  const settingsUrl = `chrome://settings/content/siteDetails?site=${encodeURIComponent(extensionOrigin)}`;
  await chrome.tabs.create({ url: settingsUrl });
  return { ok: true };
}

async function handleWebCodecsCheckSupport(quality: CaptureQuality | undefined) {
  try {
    await offscreenClient.ensureReadyWithRetry(delay);
    const result = await offscreenClient.send<{
      ok?: boolean;
      videoSupported?: boolean;
      audioSupported?: boolean;
      hardwareAcceleration?: boolean;
      fallbackReason?: string | null;
      error?: string;
    }>({
      type: RuntimeMessageType.WEBCODECS_CHECK_SUPPORT,
      quality,
    });
    return result ?? { ok: false, error: 'No response from offscreen' };
  } catch (error) {
    debugWarn('[Background] WebCodecs check failed:', error);
    return {
      ok: false,
      error: toErrorMessage(error),
      videoSupported: false,
      audioSupported: false,
      hardwareAcceleration: false,
    };
  }
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
