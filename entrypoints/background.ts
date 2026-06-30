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
  loadRecorderSettings,
  saveRecorderSettings,
  type RecorderSettings,
} from './background/state/persisted-context';
import { delay, normalizeAudioSource, normalizeCaptureQuality, normalizeMicDeviceId, toErrorMessage } from './background/utils';
import {
  handleTestControlPlaneMessage,
  installTestControlPlaneDebugHook,
  installTestControlPlaneRuntimeHandlers,
} from './background/testing/control-plane';
import { RecordingSession } from './background/recording-session';
import { createPlatformDeps } from './background/platform';

const offscreenClient = new OffscreenClient();
const deps = createPlatformDeps(offscreenClient);
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
