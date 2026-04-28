import type {
  AudioPreflightSnapshot,
  OrphanedSession,
  ProcessingMetrics,
  RecordingSnapshot,
  RecordingState,
  RecoveryChunkCheck,
  ValidationResult,
} from '@/lib/recording';
import type {
  AudioSource,
  CaptureQuality,
  CaptureResolvedQuality,
  MicMixFailedMessage,
  MicPreflightResponse,
  OffscreenEventMessage,
  OffscreenResponse,
  RecoveryInspectResponse,
  StorageSignalMessage,
  SystemAudioSignalMessage,
} from '@/lib/messages';
import { OffscreenEventType, RuntimeMessageType } from '@/lib/messages';
import { debugWarn } from '@/lib/runtime-log';
import { OffscreenClient } from './background/services/offscreen-client';
import {
  loadPersistedContext,
  savePersistedContext,
  loadRecorderSettings,
  saveRecorderSettings,
  type PersistedContext,
  type EncoderBackend,
  type RecorderSettings,
} from './background/state/persisted-context';
import { ALLOWED_TRANSITIONS } from './background/state/transitions';
import {
  createSessionId,
  delay,
  getSystemAudioPreflightSnapshot,
  normalizeAudioSource,
  normalizeCaptureQuality,
  normalizeResolvedCaptureQuality,
  normalizeMicDeviceId,
  normalizeSystemAudioStatus,
  toErrorMessage,
} from './background/utils';

type RawDownloadItem = {
  url: string;
  filename: string;
};
const PREFLIGHT_RESULT_MIN_VISIBLE_MS = 1_500;
const BLOCKED_TAB_CAPTURE_SCHEMES = ['chrome:', 'chrome-extension:', 'devtools:', 'edge:', 'about:'];
const BLOCKED_TAB_CAPTURE_HOSTS = new Set(['chromewebstore.google.com']);
const ACTIVE_TAB_CAPTURE_STATUSES = new Set<chrome.tabCapture.TabCaptureState>(['pending', 'active']);

const DEFAULT_AUDIO_PREFLIGHT: AudioPreflightSnapshot = {
  micChecked: false,
  micOk: false,
  micLevel: null,
  micError: null,
  systemAudioStatus: 'idle',
  systemAudioLevel: null,
};

let state: RecordingState = 'idle';
let sessionId: string | null = null;
let recordingStartTime: number | null = null;
let chunkCount = 0;
let processingProgress: number | null = null;
let errorMessage: string | null = null;
let micWarningMessage: string | null = null;
let storageWarningMessage: string | null = null;
let outputFileName: string | null = null;
let outputUrl: string | null = null;
let validation: ValidationResult | null = null;
let processingMetrics: ProcessingMetrics | null = null;
let audioPreflight: AudioPreflightSnapshot = { ...DEFAULT_AUDIO_PREFLIGHT };
let orphanedSessions: OrphanedSession[] = [];
let recoverySessionId: string | null = null;
let recoveryChunks: RecoveryChunkCheck[] = [];
let processingPipelineRunning = false;
let recordingTabId: number | null = null;
let activeAudioSource: AudioSource = 'both';
let selectedMicDeviceId: string | null = null;
let recordingQuality: CaptureQuality = 'auto';
let resolvedPreset: CaptureResolvedQuality | null = null;
let activeEncoderBackend: EncoderBackend = 'webcodecs';
let webCodecsStats: RecordingSnapshot['webCodecsStats'] = null;
const offscreenClient = new OffscreenClient();

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type) return;

    if (message.type === RuntimeMessageType.GET_STATE) {
      sendResponse(buildSnapshot());
      return;
    }

    if (message.type === RuntimeMessageType.START) {
      const requestedAudioSource = normalizeAudioSource(message.audioSource);
      const requestedMicDeviceId = normalizeMicDeviceId(message.micDeviceId);
      const requestedQuality = normalizeCaptureQuality(message.quality);
      void handleStart(requestedAudioSource, requestedMicDeviceId, requestedQuality).then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.PREPARE_START) {
      const includeMic = message.includeMic !== false;
      const requestedMicDeviceId = normalizeMicDeviceId(message.micDeviceId);
      const requestedQuality = normalizeCaptureQuality(message.quality);
      void handlePrepareStart(includeMic, requestedMicDeviceId, requestedQuality)
        .then(sendResponse)
        .catch((error) => {
          errorMessage = toErrorMessage(error);
          setState('preflight_error');
          sendResponse({
            ok: false,
            error: errorMessage,
            snapshot: buildSnapshot(),
          });
        });
      return true;
    }

    if (message.type === RuntimeMessageType.RUN_MIC_CHECK) {
      const requestedMicDeviceId = normalizeMicDeviceId(message.micDeviceId);
      void handleRunMicCheck(requestedMicDeviceId).then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.RELEASE_MIC_CHECK) {
      void handleReleaseMicCheck().then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.CANCEL_START) {
      void handleCancelStart().then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.STOP) {
      void handleStop().then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.DOWNLOAD) {
      void handleDownload().then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.RESET_TO_IDLE) {
      void handleResetToIdle().then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.DOWNLOAD_RAW_CHUNKS) {
      void handleDownloadRawChunks(String(message.sessionId ?? '')).then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.RECOVER_ORPHAN) {
      const chunkIndexes = Array.isArray(message.chunkIndexes)
        ? message.chunkIndexes
            .map((value: unknown) => Number(value))
            .filter((value: number) => Number.isInteger(value) && value >= 0)
        : undefined;
      void handleRecoverOrphan(String(message.sessionId ?? ''), chunkIndexes).then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.DISCARD_ORPHAN) {
      void handleDiscardOrphan(String(message.sessionId ?? '')).then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.REFRESH_ORPHANS) {
      void handleRefreshOrphans().then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.OPEN_MIC_SETTINGS) {
      const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
      const settingsUrl = `chrome://settings/content/siteDetails?site=${encodeURIComponent(extensionOrigin)}`;
      void chrome.tabs.create({ url: settingsUrl }).then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === RuntimeMessageType.OFFSCREEN_EVENT) {
      void handleOffscreenEvent(message as OffscreenEventMessage).then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.MIC_MIX_FAILED) {
      void handleMicMixFailed(message as MicMixFailedMessage).then(sendResponse);
      return true;
    }

    if (
      message.type === RuntimeMessageType.SYSTEM_AUDIO_OK ||
      message.type === RuntimeMessageType.SYSTEM_AUDIO_SILENT ||
      message.type === RuntimeMessageType.SYSTEM_AUDIO_ABSENT
    ) {
      void handleSystemAudioSignal(message as SystemAudioSignalMessage).then(sendResponse);
      return true;
    }

    if (
      message.type === RuntimeMessageType.LOW_STORAGE_WARNING ||
      message.type === RuntimeMessageType.AUTO_STOP_LOW_STORAGE
    ) {
      void handleStorageSignal(message as StorageSignalMessage).then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.WEBCODECS_FATAL_ERROR) {
      void handleWebCodecsFatalError(message.error as string | undefined).then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.OFFSCREEN_READY) {
      offscreenClient.markReady();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === RuntimeMessageType.GET_ENCODER_SETTINGS) {
      void loadRecorderSettings().then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.SET_ENCODER_SETTINGS) {
      void saveRecorderSettings(message.settings as Partial<RecorderSettings>).then(sendResponse);
      return true;
    }

    if (message.type === RuntimeMessageType.WEBCODECS_CHECK_SUPPORT) {
      void (async () => {
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
            quality: message.quality,
          });
          sendResponse(result ?? { ok: false, error: 'No response from offscreen' });
        } catch (error) {
          debugWarn('[Background] WebCodecs check failed:', error);
          sendResponse({
            ok: false,
            error: toErrorMessage(error),
            videoSupported: false,
            audioSupported: false,
            hardwareAcceleration: false,
          });
        }
      })();
      return true;
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    void handleRecordingTabUpdated(tabId, changeInfo);
  });
  chrome.runtime.onInstalled.addListener(() => {
    void refreshOrphanedSessions();
  });

  void bootstrap();
});

async function bootstrap() {
  await hydrateContext();
  await reconcileWithOffscreen();
  await refreshOrphanedSessions();
  await broadcastSnapshot();
}

function normalizeAudioPreflight(value: Partial<AudioPreflightSnapshot> | null | undefined) {
  return {
    ...DEFAULT_AUDIO_PREFLIGHT,
    ...(value ?? {}),
    systemAudioStatus: normalizeSystemAudioStatus(value?.systemAudioStatus),
  };
}

function isUsingWebCodecsBackend() {
  return activeEncoderBackend === 'webcodecs';
}

async function hydrateContext() {
  try {
    const stored = await loadPersistedContext();
    if (!stored) return;

    sessionId = stored.sessionId ?? null;
    recordingStartTime = stored.recordingStartTime ?? null;
    chunkCount = stored.chunkCount ?? 0;
    processingProgress = stored.processingProgress ?? null;
    errorMessage = stored.errorMessage ?? null;
    micWarningMessage = stored.micWarningMessage ?? null;
    storageWarningMessage = stored.storageWarningMessage ?? null;
    outputFileName = stored.outputFileName ?? null;
    validation = stored.validation ?? null;
    processingMetrics = stored.processingMetrics ?? null;
    audioPreflight = normalizeAudioPreflight(stored.audioPreflight);
    orphanedSessions = Array.isArray(stored.orphanedSessions) ? stored.orphanedSessions : [];
    recoverySessionId = stored.recoverySessionId ?? null;
    recoveryChunks = Array.isArray(stored.recoveryChunks) ? stored.recoveryChunks : [];
    recordingQuality = normalizeCaptureQuality(stored.requestedPreset ?? stored.recordingQuality);
    resolvedPreset =
      stored.resolvedPreset == null ? null : normalizeResolvedCaptureQuality(stored.resolvedPreset);
    activeEncoderBackend = stored.usingWebCodecs === false ? 'mediarecorder' : 'webcodecs';
    webCodecsStats = stored.webCodecsStats ?? null;
    outputUrl = null;

    if (stored.state === 'done') {
      errorMessage = 'Output must be reprocessed before download.';
      setState('recovery', { force: true });
      return;
    }

    // WebCodecs uses OPFS (webcodecs-stream.mp4 + manifest); after SW restart,
    // reconcileWithOffscreen moves to recovery so the user can reprocess like MediaRecorder orphans.

    setState(stored.state ?? 'idle', { force: true });
  } catch (error) {
    console.error('Failed to hydrate context', error);
    errorMessage = toErrorMessage(error);
    setState('error', { force: true });
  }
}

async function reconcileWithOffscreen() {
  if (!['recording', 'stopping', 'processing'].includes(state)) return;

  try {
    const status = await offscreenClient.send<{
      alive?: boolean;
      chunkCount?: number;
      isRecording?: boolean;
      isWebCodecsRecording?: boolean;
    }>({ type: RuntimeMessageType.OFFSCREEN_STATUS });

    if (!status?.alive) {
      errorMessage = 'Offscreen recorder is unavailable.';
      setState('recovery', { force: true });
      return;
    }

    const captureLive = status.isRecording === true || status.isWebCodecsRecording === true;
    if (state === 'recording' && !captureLive) {
      errorMessage = 'Recording session was lost.';
      setState('recovery', { force: true });
      return;
    }

    if (typeof status.chunkCount === 'number') {
      chunkCount = Math.max(chunkCount, status.chunkCount);
      await persistContext();
    }
  } catch {
    errorMessage = 'Unable to reconnect to offscreen recorder.';
    setState('recovery', { force: true });
  }
}

function hasActiveRuntimeRecording() {
  return ['recording', 'stopping', 'processing'].includes(state);
}

async function refreshOrphanedSessions() {
  try {
    await offscreenClient.ensureReadyWithRetry(delay);
    const result = await offscreenClient.send<{ ok?: boolean; sessions?: OrphanedSession[]; error?: string }>({
      type: RuntimeMessageType.OFFSCREEN_SCAN_ORPHANS,
    });

    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    orphanedSessions = sessions.filter((session) => {
      if (!hasActiveRuntimeRecording()) return true;
      if (!sessionId) return true;
      return session.sessionId !== sessionId;
    });
    await persistContext();
    await broadcastSnapshot();
  } catch {
    // Keep the last known orphan list when scan is unavailable.
  }
}

function buildSnapshot(): RecordingSnapshot {
  const elapsedSeconds =
    state === 'recording' && recordingStartTime
      ? Math.max(0, Math.floor((Date.now() - recordingStartTime) / 1000))
      : 0;

  return {
    state,
    sessionId,
    recordingStartTime,
    elapsedSeconds,
    chunkCount,
    processingProgress,
    errorMessage,
    micWarningMessage,
    storageWarningMessage,
    canDownload: Boolean(outputUrl) && (state === 'done' || state === 'recovery'),
    outputFileName,
    requestedPreset: recordingQuality,
    resolvedPreset,
    recordingQuality,
    validation,
    processingMetrics,
    audioPreflight,
    orphanedSessions,
    recoverySessionId,
    recoveryChunks,
    webCodecsStats,
  };
}

function setState(next: RecordingState, options?: { force?: boolean }) {
  if (next === state) {
    updateBadge(next);
    void syncRecordingBanner(next);
    void persistContext();
    void broadcastSnapshot();
    return;
  }

  if (!options?.force && !ALLOWED_TRANSITIONS[state].includes(next)) {
    console.warn(`Blocked invalid transition ${state} -> ${next}`);
    return;
  }

  state = next;
  updateBadge(next);
  void syncRecordingBanner(next);
  void persistContext();
  void broadcastSnapshot();
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

async function persistContext() {
  const payload: PersistedContext = {
    state,
    sessionId,
    recordingStartTime,
    chunkCount,
    processingProgress,
    errorMessage,
    micWarningMessage,
    storageWarningMessage,
    outputFileName,
    requestedPreset: recordingQuality,
    resolvedPreset,
    recordingQuality,
    validation,
    processingMetrics,
    audioPreflight,
    orphanedSessions,
    recoverySessionId,
    recoveryChunks,
    webCodecsStats,
  };
  await savePersistedContext(payload);
}

async function broadcastSnapshot() {
  try {
    await chrome.runtime.sendMessage({
      type: RuntimeMessageType.STATE_CHANGE,
      snapshot: buildSnapshot(),
    });
  } catch {
    // Popup is usually closed; ignore.
  }
}

async function syncRecordingBanner(next: RecordingState) {
  if (next === 'recording') {
    if (recordingTabId === null) return;
    await ensureRecordingBannerVisible(recordingTabId);
    return;
  }

  if (recordingTabId === null) return;
  const targetTabId = recordingTabId;
  recordingTabId = null;
  await sendRecordingBanner(targetTabId, false);
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

async function handleRecordingTabUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) {
  if (recordingTabId === null || tabId !== recordingTabId) return;
  if (state !== 'recording') return;
  if (changeInfo.status !== 'complete') return;
  await ensureRecordingBannerVisible(tabId);
}

function resetSessionMetadata(nextSessionId: string) {
  sessionId = nextSessionId;
  recordingStartTime = null;
  chunkCount = 0;
  processingProgress = null;
  errorMessage = null;
  micWarningMessage = null;
  storageWarningMessage = null;
  outputFileName = null;
  outputUrl = null;
  validation = null;
  processingMetrics = null;
  recoverySessionId = null;
  recoveryChunks = [];
  webCodecsStats = null;
  resolvedPreset = null;
  audioPreflight = {
    ...audioPreflight,
    systemAudioStatus: 'idle',
    systemAudioLevel: null,
  };
}

function resetAttemptMetadata() {
  sessionId = null;
  recordingStartTime = null;
  chunkCount = 0;
  processingProgress = null;
  errorMessage = null;
  micWarningMessage = null;
  storageWarningMessage = null;
  outputFileName = null;
  outputUrl = null;
  validation = null;
  processingMetrics = null;
  recoverySessionId = null;
  recoveryChunks = [];
  audioPreflight = { ...DEFAULT_AUDIO_PREFLIGHT };
  activeAudioSource = 'both';
  selectedMicDeviceId = null;
  resolvedPreset = null;
  webCodecsStats = null;
}

async function handleStart(
  audioSource: AudioSource = 'both',
  micDeviceId: string | null = null,
  quality: CaptureQuality = 'auto',
) {
  if (state !== 'armed') {
    return { ok: false, error: `Cannot start from state "${state}"`, snapshot: buildSnapshot() };
  }

  activeAudioSource = audioSource;
  selectedMicDeviceId = audioSource === 'both' || audioSource === 'mic' ? micDeviceId : null;
  recordingQuality = normalizeCaptureQuality(quality);
  resolvedPreset = null;
  const nextSessionId = createSessionId();
  resetSessionMetadata(nextSessionId);

  // Encoder backend is productized settings now (WebCodecs default, legacy optional).
  const recorderSettings = await loadRecorderSettings();
  activeEncoderBackend = recorderSettings.encoderBackend;

  try {
    const targetTabId = await getStartTargetTabId();
    const staleCaptureRecovery = await releaseStaleTabCapture(targetTabId);
    if (!staleCaptureRecovery.ok) {
      errorMessage = formatCodedStartError(
        'TAB_CAPTURE_ACTIVE',
        'Chrome still has an active capture attached to this tab. Stop the current share and try again.',
        staleCaptureRecovery.detail,
      );
      setState('preflight_error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }

    const streamId = await getTabCaptureStreamId(targetTabId);
    if (!streamId) {
      errorMessage = formatCodedStartError(
        'TAB_CAPTURE_STREAM_UNAVAILABLE',
        'Could not create a capture stream for the current tab. Reload the tab and try again.',
      );
      setState('preflight_error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }

    recordingTabId = targetTabId;

    let result: OffscreenResponse;
    const startMediaRecorder = async () =>
      await offscreenClient.send<OffscreenResponse>({
        type: RuntimeMessageType.OFFSCREEN_START,
        sessionId: nextSessionId,
        streamId,
        audioSource,
        micDeviceId: selectedMicDeviceId,
        quality: recordingQuality,
      });

    if (isUsingWebCodecsBackend()) {
      // 4.1: WebCodecs primary path with automatic MediaRecorder fallback.
      let webCodecsError: string | null = null;
      try {
        const webCodecsResult = await offscreenClient.send<OffscreenResponse>({
          type: RuntimeMessageType.OFFSCREEN_START_WEBCODECS,
          sessionId: nextSessionId,
          streamId,
          quality: recordingQuality,
          audioSource,
          micDeviceId: selectedMicDeviceId,
        });
        if (webCodecsResult?.ok) {
          result = webCodecsResult;
        } else {
          webCodecsError = webCodecsResult?.error ?? 'Unknown WebCodecs start failure';
          debugWarn('[Background] WebCodecs start failed; falling back to MediaRecorder:', webCodecsError);
          activeEncoderBackend = 'mediarecorder';
          const fallback = await startMediaRecorder();
          result =
            fallback?.ok || !fallback
              ? fallback
              : {
                  ...fallback,
                  error: `WebCodecs start failed (${webCodecsError}). MediaRecorder fallback also failed: ${fallback.error ?? 'Unknown fallback failure'}`,
                };
        }
      } catch (error) {
        webCodecsError = toErrorMessage(error);
        debugWarn('[Background] WebCodecs start threw; falling back to MediaRecorder:', webCodecsError);
        activeEncoderBackend = 'mediarecorder';
        const fallback = await startMediaRecorder();
        result =
          fallback?.ok || !fallback
            ? fallback
            : {
                ...fallback,
                error: `WebCodecs start failed (${webCodecsError}). MediaRecorder fallback also failed: ${fallback.error ?? 'Unknown fallback failure'}`,
              };
      }
    } else {
      result = await startMediaRecorder();
    }

    if (!result?.ok) {
      recordingTabId = null;
      errorMessage = normalizeStartFailureMessage(result?.error ?? 'Failed to start recorder');
      setState('preflight_error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }

    recordingQuality = normalizeCaptureQuality(result.requestedPreset ?? recordingQuality);
    resolvedPreset =
      result.resolvedPreset == null ? null : normalizeResolvedCaptureQuality(result.resolvedPreset);

    recordingStartTime = Date.now();
    audioPreflight = {
      ...audioPreflight,
      ...getSystemAudioPreflightSnapshot(activeAudioSource, isUsingWebCodecsBackend()),
    };
    await persistContext();
    await broadcastSnapshot();
    setState('recording');
    return { ok: true, snapshot: buildSnapshot() };
  } catch (error) {
    recordingTabId = null;
    errorMessage = normalizeStartFailureMessage(toErrorMessage(error));
    setState('preflight_error');
    return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
  }
}

async function handlePrepareStart(
  includeMic = true,
  micDeviceId: string | null = null,
  quality: CaptureQuality = 'auto',
) {
  try {
    if (state === 'armed') {
      recordingQuality = normalizeCaptureQuality(quality);
      resolvedPreset = null;
      await persistContext();
      await broadcastSnapshot();
      return { ok: true, snapshot: buildSnapshot() };
    }

    if (!['idle', 'done', 'preflight_error', 'recovery', 'error'].includes(state)) {
      return { ok: false, error: `Cannot prepare from state "${state}"`, snapshot: buildSnapshot() };
    }

    recordingQuality = normalizeCaptureQuality(quality);
    resolvedPreset = null;
    resetAttemptMetadata();
    await persistContext();
    await broadcastSnapshot();

    const storageCheck = await checkStorageQuota();
    storageWarningMessage = storageCheck.warningMessage ?? null;
    if (!storageCheck.ok) {
      errorMessage = storageCheck.warningMessage ?? 'Insufficient storage to start recording';
      setState('preflight_error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }

    setState('preflight');
    const preflightStartedAt = Date.now();

    const targetTabId = await getStartTargetTabId();
    const staleCaptureRecovery = await releaseStaleTabCapture(targetTabId);
    if (!staleCaptureRecovery.ok) {
      errorMessage = formatCodedStartError(
        'TAB_CAPTURE_ACTIVE',
        'Chrome still has an active capture attached to this tab. Stop the current share and try again.',
        staleCaptureRecovery.detail,
      );
      setState('preflight_error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }

    await offscreenClient.ensureReadyWithRetry(delay);

    if (!includeMic) {
      selectedMicDeviceId = null;
      audioPreflight = {
        ...audioPreflight,
        micChecked: true,
        micOk: true,
        micLevel: null,
        micError: null,
        systemAudioStatus: 'idle',
        systemAudioLevel: null,
      };
      errorMessage = null;
      await persistContext();
      await broadcastSnapshot();
      setState('armed');
      return { ok: true, snapshot: buildSnapshot() };
    }

    selectedMicDeviceId = micDeviceId;
    const micPreflight = await runMicPreflight(selectedMicDeviceId);
    audioPreflight = {
      ...audioPreflight,
      micChecked: true,
      micOk: micPreflight.ok,
      micLevel: typeof micPreflight.level === 'number' ? micPreflight.level : null,
      micError: micPreflight.error ?? null,
      systemAudioStatus: 'idle',
      systemAudioLevel: null,
    };
    await persistContext();
    await broadcastSnapshot();

    const visibleMs = Date.now() - preflightStartedAt;
    if (visibleMs < PREFLIGHT_RESULT_MIN_VISIBLE_MS) {
      await delay(PREFLIGHT_RESULT_MIN_VISIBLE_MS - visibleMs);
    }

    if (!micPreflight.ok) {
      errorMessage = micPreflight.error ?? 'Microphone pre-flight failed';
      setState('preflight_error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }
    errorMessage = null;
    setState('armed');
    return { ok: true, snapshot: buildSnapshot() };
  } catch (error) {
    errorMessage = toErrorMessage(error);
    setState('preflight_error');
    return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
  }
}

async function runMicPreflight(micDeviceId: string | null = null): Promise<MicPreflightResponse> {
  try {
    const payload: Record<string, unknown> = { type: RuntimeMessageType.MIC_PREFLIGHT };
    if (micDeviceId) {
      payload.micDeviceId = micDeviceId;
    }
    const result = await offscreenClient.send<MicPreflightResponse>(payload);
    if (!result?.ok) {
      return {
        ok: false,
        error: result?.error ?? 'Microphone pre-flight failed',
      };
    }

    return {
      ok: true,
      level: typeof result.level === 'number' ? result.level : 0,
      deviceLabel: typeof result.deviceLabel === 'string' ? result.deviceLabel : null,
    };
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
    };
  }
}

async function handleRunMicCheck(micDeviceId: string | null = null) {
  if (!['idle', 'done', 'preflight_error', 'recovery', 'error'].includes(state)) {
    return {
      ok: false,
      error: `Cannot check microphone from state "${state}"`,
      snapshot: buildSnapshot(),
    };
  }

  selectedMicDeviceId = micDeviceId;
  const micPreflight = await runMicPreflight(selectedMicDeviceId);
  audioPreflight = {
    ...audioPreflight,
    micChecked: true,
    micOk: micPreflight.ok,
    micLevel: typeof micPreflight.level === 'number' ? micPreflight.level : null,
    micError: micPreflight.error ?? null,
  };
  if (micPreflight.ok) {
    micWarningMessage = null;
  }

  await persistContext();
  await broadcastSnapshot();
  return {
    ok: micPreflight.ok,
    level: micPreflight.level,
    deviceLabel: micPreflight.deviceLabel ?? null,
    error: micPreflight.error,
    snapshot: buildSnapshot(),
  };
}

async function handleReleaseMicCheck() {
  await releasePreflightMicHold();
  audioPreflight = {
    ...audioPreflight,
    micChecked: false,
    micOk: false,
    micLevel: null,
    micError: null,
  };
  micWarningMessage = null;
  await persistContext();
  await broadcastSnapshot();
  return { ok: true, snapshot: buildSnapshot() };
}

async function releasePreflightMicHold() {
  try {
    await offscreenClient.ensureReadyWithRetry(delay);
    await offscreenClient.send<{ ok?: boolean }>({
      type: RuntimeMessageType.OFFSCREEN_RELEASE_PREFLIGHT_MIC,
    });
  } catch {
    // Best-effort cleanup for any preflight-held mic stream.
  }
}

async function checkStorageQuota() {
  try {
    const estimate = await navigator.storage.estimate();
    const availableBytes = Math.max(0, (estimate.quota ?? 0) - (estimate.usage ?? 0));
    const availableMB = availableBytes / (1024 * 1024);

    if (availableMB < 50) {
      return {
        ok: false,
        warningMessage: `Only ${Math.round(availableMB)}MB available. Free up storage before recording.`,
      };
    }

    if (availableMB < 500) {
      return {
        ok: true,
        warningMessage: `Low storage: ~${Math.round(availableMB / 100)} min of recording remaining.`,
      };
    }

    return { ok: true };
  } catch {
    // If storage estimate is unavailable, do not block recording.
    return { ok: true };
  }
}

async function handleCancelStart() {
  if (state === 'armed') {
    await releasePreflightMicHold();
    errorMessage = null;
    setState('idle');
  } else if (state === 'preflight') {
    await releasePreflightMicHold();
    errorMessage = null;
    setState('idle', { force: true });
  }
  return { ok: true, snapshot: buildSnapshot() };
}

async function handleStop() {
  if (state !== 'recording') {
    return { ok: false, error: `Cannot stop from state "${state}"`, snapshot: buildSnapshot() };
  }

  setState('stopping');

  try {
    if (isUsingWebCodecsBackend()) {
      // WebCodecs path: stop returns the final MP4 directly, no processing needed
      const result = await offscreenClient.send<OffscreenResponse & {
        outputSize?: number;
        stopDurationMs?: number;
      }>({
        type: RuntimeMessageType.OFFSCREEN_STOP_WEBCODECS,
      });

      if (!result?.ok) {
        errorMessage = result?.error ?? 'Failed to stop WebCodecs recorder';
        activeEncoderBackend = 'webcodecs';
        setState('error');
        return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
      }

      // WebCodecs returns the output directly - skip processing
      outputUrl = result.outputUrl ?? null;
      outputFileName = result.fileName ?? `${sessionId ?? 'recording'}.mp4`;
      validation = result.validation ?? null;
      processingProgress = 100;

      activeEncoderBackend = 'webcodecs';
      await persistContext();
      await broadcastSnapshot();

      // Go directly to done (skip processing/validating for WebCodecs)
      setState('done', { force: true });
      return { ok: true, snapshot: buildSnapshot() };
    }

    // Standard MediaRecorder path
    const result = await offscreenClient.send<OffscreenResponse>({
      type: RuntimeMessageType.OFFSCREEN_STOP,
      sessionId,
    });

    if (!result?.ok) {
      errorMessage = result?.error ?? 'Failed to stop recorder';
      setState('error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }

    return { ok: true, snapshot: buildSnapshot() };
  } catch (error) {
    errorMessage = toErrorMessage(error);
    activeEncoderBackend = 'webcodecs';
    setState('error');
    return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
  }
}

async function handleWebCodecsFatalError(errorMsg?: string) {
  if (!isUsingWebCodecsBackend() || !['recording', 'stopping', 'error'].includes(state)) {
    return { ok: true };
  }

  debugWarn('[Background] WebCodecs fatal error, triggering graceful stop:', errorMsg);
  try {
    const status = await offscreenClient.send<{
      alive?: boolean;
      isWebCodecsRecording?: boolean;
    }>({
      type: RuntimeMessageType.OFFSCREEN_STATUS,
    });

    if (status?.alive && status.isWebCodecsRecording) {
      const result = await offscreenClient.send<OffscreenResponse>({
        type: RuntimeMessageType.OFFSCREEN_STOP_WEBCODECS,
      });

      if (result?.ok) {
        outputUrl = result.outputUrl ?? null;
        outputFileName = result.fileName ?? `${sessionId ?? 'recording'}.mp4`;
        validation = result.validation ?? null;
        processingProgress = 100;
        await persistContext();
        await broadcastSnapshot();
        setState('done', { force: true });
        return { ok: true, snapshot: buildSnapshot() };
      }
    }
  } catch (error) {
    debugWarn('[Background] Graceful WebCodecs fatal stop failed:', error);
  }

  try {
    await offscreenClient.send<{ ok?: boolean; error?: string }>({
      type: RuntimeMessageType.OFFSCREEN_FORCE_CLEANUP,
    });
  } catch (error) {
    debugWarn('[Background] Forced WebCodecs cleanup failed:', error);
  }

  recordingTabId = null;
  resetAttemptMetadata();
  errorMessage = errorMsg ?? 'WebCodecs recording failed unexpectedly';
  activeEncoderBackend = 'webcodecs';
  setState('error', { force: true });
  return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
}

async function handleDownload() {
  if (!outputUrl) {
    return { ok: false, error: 'No processed MP4 is available yet', snapshot: buildSnapshot() };
  }

  try {
    const filename = outputFileName ?? `${sessionId ?? 'recording'}.mp4`;
    const downloadId = await chrome.downloads.download({
      url: outputUrl,
      filename,
      saveAs: true,
    });

    setState('idle');
    return { ok: true, downloadId, snapshot: buildSnapshot() };
  } catch (error) {
    errorMessage = toErrorMessage(error);
    setState('error');
    return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
  }
}

async function handleResetToIdle() {
  if (['recording', 'stopping', 'processing', 'validating', 'armed'].includes(state)) {
    return {
      ok: false,
      error: `Cannot reset while state is "${state}"`,
      snapshot: buildSnapshot(),
    };
  }

  await releasePreflightMicHold();
  resetAttemptMetadata();
  setState('idle', { force: true });
  return { ok: true, snapshot: buildSnapshot() };
}

async function handleDownloadRawChunks(targetSessionId: string) {
  if (!targetSessionId) {
    return { ok: false, error: 'Missing session id', snapshot: buildSnapshot() };
  }

  try {
    await offscreenClient.ensureReadyWithRetry(delay);
    const result = await offscreenClient.send<{
      ok?: boolean;
      error?: string;
      items?: RawDownloadItem[];
    }>({
      type: RuntimeMessageType.OFFSCREEN_DOWNLOAD_RAW_CHUNKS,
      sessionId: targetSessionId,
    });

    if (!result?.ok) {
      return {
        ok: false,
        error: result?.error ?? 'Failed to download raw chunks',
        snapshot: buildSnapshot(),
      };
    }

    const items = Array.isArray(result.items) ? result.items : [];
    if (!items.length) {
      return {
        ok: false,
        error: 'No raw files available to download',
        snapshot: buildSnapshot(),
      };
    }

    let downloadCount = 0;
    for (const item of items) {
      if (!item?.url || !item?.filename) continue;
      try {
        await chrome.downloads.download({
          url: item.url,
          filename: item.filename,
          saveAs: false,
        });
        downloadCount += 1;
      } catch {
        // Continue attempting remaining files even if one download fails.
      }
    }

    if (!downloadCount) {
      return {
        ok: false,
        error: 'Unable to trigger raw file downloads',
        snapshot: buildSnapshot(),
      };
    }

    return {
      ok: true,
      downloadCount,
      snapshot: buildSnapshot(),
    };
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
      snapshot: buildSnapshot(),
    };
  }
}

async function handleSystemAudioSignal(message: SystemAudioSignalMessage) {
  if (state !== 'recording') {
    return { ok: true };
  }

  if (message.type === RuntimeMessageType.SYSTEM_AUDIO_OK) {
    audioPreflight = {
      ...audioPreflight,
      systemAudioStatus: 'ok',
      systemAudioLevel: typeof message.level === 'number' ? message.level : null,
    };
    errorMessage = null;
    micWarningMessage = null;
    await persistContext();
    await broadcastSnapshot();
    return { ok: true };
  }

  const warningMessage = (() => {
    if (activeAudioSource === 'both') {
      return message.type === RuntimeMessageType.SYSTEM_AUDIO_ABSENT
        ? 'System audio track is missing. Recording continues with microphone.'
        : 'System audio appears silent. Recording continues with microphone.';
    }
    if (activeAudioSource === 'tab') {
      return message.type === RuntimeMessageType.SYSTEM_AUDIO_ABSENT
        ? 'System audio track is missing. The recording may not include tab audio.'
        : 'System audio appears silent. Check the tab output volume.';
    }
    return null;
  })();

  audioPreflight = {
    ...audioPreflight,
    systemAudioStatus: message.type === RuntimeMessageType.SYSTEM_AUDIO_ABSENT ? 'absent' : 'silent',
    systemAudioLevel: typeof message.level === 'number' ? message.level : null,
  };
  micWarningMessage = warningMessage;
  errorMessage = null;
  await persistContext();
  await broadcastSnapshot();
  return { ok: true };
}

async function handleStorageSignal(message: StorageSignalMessage) {
  const availableMB =
    typeof message.availableMB === 'number' && Number.isFinite(message.availableMB)
      ? Math.max(0, message.availableMB)
      : null;

  if (message.type === RuntimeMessageType.LOW_STORAGE_WARNING) {
    storageWarningMessage =
      availableMB === null
        ? 'Low storage detected while recording.'
        : `Low storage warning: ${Math.round(availableMB)}MB remaining.`;
    await persistContext();
    await broadcastSnapshot();
    return { ok: true };
  }

  storageWarningMessage =
    availableMB === null
      ? 'Critical storage level reached. Stopping recording safely.'
      : `Critical storage level (${Math.round(availableMB)}MB). Stopping recording safely.`;
  errorMessage = storageWarningMessage;
  await persistContext();
  await broadcastSnapshot();

  if (state === 'recording') {
    return await handleStop();
  }

  return { ok: true, snapshot: buildSnapshot() };
}

async function handleRefreshOrphans() {
  await refreshOrphanedSessions();
  return { ok: true, snapshot: buildSnapshot() };
}

function primeRecoveredSessionContext(orphan: OrphanedSession) {
  sessionId = orphan.sessionId;
  recordingStartTime = null;
  chunkCount = orphan.chunkCount;
  processingProgress = null;
  errorMessage = null;
  micWarningMessage = null;
  outputFileName = null;
  outputUrl = null;
  validation = null;
  processingMetrics = null;
  recoverySessionId = null;
  recoveryChunks = [];
  audioPreflight = { ...DEFAULT_AUDIO_PREFLIGHT };
}

async function handleRecoverOrphan(targetSessionId: string, chunkIndexes?: number[]) {
  try {
    if (!targetSessionId) {
      return { ok: false, error: 'Missing session id', snapshot: buildSnapshot() };
    }

    if (['preflight', 'armed', 'recording', 'stopping', 'processing'].includes(state)) {
      return {
        ok: false,
        error: `Cannot recover while state is "${state}"`,
        snapshot: buildSnapshot(),
      };
    }

    const target = orphanedSessions.find((session) => session.sessionId === targetSessionId);
    if (!target) {
      await refreshOrphanedSessions();
    }

    let resolvedTarget = target ?? orphanedSessions.find((session) => session.sessionId === targetSessionId);
    if (!resolvedTarget) {
      const canUseActiveRecoverySession =
        state === 'recovery' &&
        (recoverySessionId === targetSessionId || sessionId === targetSessionId);

      if (canUseActiveRecoverySession) {
        resolvedTarget = {
          sessionId: targetSessionId,
          startTime: recordingStartTime ?? Date.now(),
          chunkCount: recoveryChunks.length > 0 ? recoveryChunks.length : chunkCount,
          totalSize: 0,
        };
      } else {
        return { ok: false, error: 'Orphaned session not found', snapshot: buildSnapshot() };
      }
    }

    let selectedChunkIndexes = chunkIndexes;
    if (!Array.isArray(selectedChunkIndexes) || !selectedChunkIndexes.length) {
      await offscreenClient.ensureReadyWithRetry(delay);
      const inspect = await offscreenClient.send<RecoveryInspectResponse>({
        type: RuntimeMessageType.OFFSCREEN_RECOVERY_INSPECT,
        sessionId: targetSessionId,
      });

      if (!inspect?.ok) {
        return {
          ok: false,
          error: inspect?.error ?? 'Failed to inspect orphaned session chunks',
          snapshot: buildSnapshot(),
        };
      }

      recordingQuality = normalizeCaptureQuality(inspect.recordingQuality);
      resolvedPreset =
        inspect.recordingResolvedQuality == null
          ? null
          : normalizeResolvedCaptureQuality(inspect.recordingResolvedQuality);

      const inspectedChunks = Array.isArray(inspect.chunks) ? inspect.chunks : [];
      const suspectChunks = inspectedChunks.filter((chunk) => chunk.status !== 'ok');
      if (suspectChunks.length) {
        recoverySessionId = targetSessionId;
        recoveryChunks = inspectedChunks.map((chunk) => ({
          ...chunk,
          included: chunk.status !== 'missing' && chunk.status === 'ok',
        }));
        errorMessage = 'Suspect chunks detected. Select chunks to include before processing.';
        setState('recovery');
        return {
          ok: false,
          error: errorMessage,
          snapshot: buildSnapshot(),
        };
      }

      selectedChunkIndexes = inspectedChunks
        .filter((chunk) => chunk.status !== 'missing')
        .map((chunk) => chunk.index);
    }

    const fallbackRecoveryChunks =
      recoverySessionId === resolvedTarget.sessionId && recoveryChunks.length
        ? recoveryChunks.map((chunk) => ({ ...chunk }))
        : [];

    primeRecoveredSessionContext(resolvedTarget);
    await persistContext();
    await broadcastSnapshot();

    await runProcessingPipeline({
      targetSessionId: resolvedTarget.sessionId,
      chunkIndexes: selectedChunkIndexes,
      fallbackRecoveryChunks,
    });

    if (state === 'done' && outputUrl) {
      const downloadResult = await handleDownload();
      await refreshOrphanedSessions();
      return {
        ok: Boolean(downloadResult?.ok),
        error: downloadResult?.ok ? undefined : (downloadResult?.error as string | undefined),
        snapshot: buildSnapshot(),
      };
    }

    await refreshOrphanedSessions();
    if (state === 'error' || state === 'recovery') {
      return {
        ok: false,
        error: errorMessage ?? 'Failed to recover orphaned session',
        snapshot: buildSnapshot(),
      };
    }

    return { ok: true, snapshot: buildSnapshot() };
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
      snapshot: buildSnapshot(),
    };
  }
}

async function handleDiscardOrphan(targetSessionId: string) {
  if (!targetSessionId) {
    return { ok: false, error: 'Missing session id', snapshot: buildSnapshot() };
  }

  try {
    await offscreenClient.ensureReadyWithRetry(delay);
    const result = await offscreenClient.send<{ ok?: boolean; error?: string }>({
      type: RuntimeMessageType.OFFSCREEN_CLEAR_SESSION,
      sessionId: targetSessionId,
    });

    if (!result?.ok) {
      return {
        ok: false,
        error: result?.error ?? 'Failed to discard orphaned session',
        snapshot: buildSnapshot(),
      };
    }

    orphanedSessions = orphanedSessions.filter((session) => session.sessionId !== targetSessionId);
    if (recoverySessionId === targetSessionId) {
      recoverySessionId = null;
      recoveryChunks = [];
    }
    await persistContext();
    await broadcastSnapshot();
    await refreshOrphanedSessions();
    return { ok: true, snapshot: buildSnapshot() };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error), snapshot: buildSnapshot() };
  }
}

async function handleOffscreenEvent(message: OffscreenEventMessage) {
  if (typeof message.chunkCount === 'number') {
    chunkCount = Math.max(chunkCount, message.chunkCount);
    await persistContext();
    await broadcastSnapshot();
  }

  if (message.event === OffscreenEventType.PROCESS_PROGRESS && typeof message.progress === 'number') {
    const nextProgress = Math.max(0, Math.min(100, Math.floor(message.progress)));
    const currentProgress = typeof processingProgress === 'number' ? processingProgress : 0;
    processingProgress = Math.max(currentProgress, nextProgress);
    await persistContext();
    await broadcastSnapshot();
    return { ok: true };
  }

  if (message.event === OffscreenEventType.PROCESS_METRICS && message.metrics) {
    processingMetrics = message.metrics;
    await persistContext();
    await broadcastSnapshot();
    return { ok: true };
  }

  if (message.event === OffscreenEventType.WEBCODECS_STATS && message.webCodecsStats) {
    webCodecsStats = message.webCodecsStats;
    await persistContext();
    await broadcastSnapshot();
    return { ok: true };
  }

  if (message.event === OffscreenEventType.ERROR) {
    errorMessage = message.error ?? 'Offscreen pipeline error';
    if (isUsingWebCodecsBackend() && ['recording', 'stopping'].includes(state)) {
      await persistContext();
      await broadcastSnapshot();
      return { ok: true };
    }
    setState('error');
    return { ok: true };
  }

  if (message.event === OffscreenEventType.FINAL_CHUNK_WRITTEN) {
    if (state === 'stopping' && !isUsingWebCodecsBackend()) {
      // Critical transition: stopping -> processing happens only after OPFS confirms final chunk write.
      // WebCodecs path handles stop->done directly in handleStop, so skip processing here.
      await runProcessingPipeline();
    }
    return { ok: true };
  }

  return { ok: true };
}

async function handleMicMixFailed(message: MicMixFailedMessage) {
  if (!['armed', 'recording', 'stopping'].includes(state)) {
    return { ok: true };
  }

  if (activeAudioSource === 'tab' || activeAudioSource === 'silent') {
    return { ok: true };
  }

  micWarningMessage =
    message.fallback === 'mic_only'
      ? 'Tab audio unavailable — continuing with microphone only.'
      : 'Microphone unavailable — continuing without mic audio.';
  audioPreflight = {
    ...audioPreflight,
    micOk: message.fallback === 'mic_only',
    micError: message.reason ?? RuntimeMessageType.MIC_MIX_FAILED,
  };
  await persistContext();
  await broadcastSnapshot();
  return { ok: true };
}

async function runProcessingPipeline(options?: {
  targetSessionId?: string;
  chunkIndexes?: number[];
  fallbackRecoveryChunks?: RecoveryChunkCheck[];
}) {
  if (processingPipelineRunning) return;
  const targetSessionId = options?.targetSessionId ?? sessionId;
  if (!targetSessionId) {
    errorMessage = 'Missing session id for processing';
    setState('error');
    return;
  }

  sessionId = targetSessionId;

  processingPipelineRunning = true;
  try {
    processingProgress = 0;
    setState('processing');

    const processPayload: Record<string, unknown> = {
      type: RuntimeMessageType.OFFSCREEN_PROCESS,
      sessionId: targetSessionId,
    };
    if (Array.isArray(options?.chunkIndexes) && options.chunkIndexes.length) {
      processPayload.chunkIndexes = options.chunkIndexes;
    }

    const processResult = await offscreenClient.send<OffscreenResponse>(processPayload);

    if (!processResult?.ok || !processResult.outputUrl) {
      errorMessage = processResult?.error ?? 'MP4 processing failed';
      setState('error');
      return;
    }

    outputUrl = processResult.outputUrl;
    outputFileName = processResult.fileName ?? `${targetSessionId}.mp4`;
    processingProgress = 100;
    validation = processResult.validation ?? null;
    await persistContext();
    await broadcastSnapshot();

    setState('validating');

    const validationResult =
      validation ??
      (await offscreenClient.send<ValidationResult>({
        type: RuntimeMessageType.OFFSCREEN_VALIDATE,
      }));

    validation = validationResult ?? null;
    await persistContext();
    await broadcastSnapshot();

    if (!validationResult?.passed) {
      recoverySessionId = targetSessionId;
      let inspectError: string | null = null;

      try {
        const inspect = await offscreenClient.send<RecoveryInspectResponse>({
          type: RuntimeMessageType.OFFSCREEN_RECOVERY_INSPECT,
          sessionId: targetSessionId,
        });

        if (inspect?.ok && Array.isArray(inspect.chunks) && inspect.chunks.length > 0) {
          recoveryChunks = inspect.chunks.map((chunk) => ({
            ...chunk,
            included: chunk.status !== 'missing',
          }));
        } else {
          inspectError = inspect?.error ?? null;
          recoveryChunks = Array.isArray(options?.fallbackRecoveryChunks)
            ? options.fallbackRecoveryChunks.map((chunk) => ({ ...chunk }))
            : [];
        }
      } catch (error) {
        inspectError = toErrorMessage(error);
        recoveryChunks = Array.isArray(options?.fallbackRecoveryChunks)
          ? options.fallbackRecoveryChunks.map((chunk) => ({ ...chunk }))
          : [];
      }

      errorMessage = inspectError
        ? `Validation failed again (${inspectError}). Try fewer chunks or download raw files.`
        : 'Validation failed again. Try fewer chunks or download raw files.';

      setState('recovery');
      return;
    }

    errorMessage = null;
    recoverySessionId = null;
    recoveryChunks = [];
    setState('done');
  } catch (error) {
    errorMessage = toErrorMessage(error);
    setState('error');
  } finally {
    processingPipelineRunning = false;
  }
}

async function getStartTargetTabId() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  if (!activeTab?.id) {
    throw new Error(
      formatCodedStartError(
        'TAB_NOT_AVAILABLE',
        'No active tab is available to record. Focus a browser tab and try again.',
      ),
    );
  }

  if (typeof activeTab.url === 'string' && activeTab.url.trim()) {
    const capturable = isTabUrlCapturable(activeTab.url);
    if (!capturable.ok) {
      throw new Error(formatCodedStartError(capturable.code, capturable.message, activeTab.url));
    }
  }
  return activeTab.id;
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
      (item) => item.tabId === targetTabId && ACTIVE_TAB_CAPTURE_STATUSES.has(item.status),
    ) ?? null
  );
}

async function releaseStaleTabCapture(targetTabId: number): Promise<{ ok: boolean; detail?: string }> {
  const activeCapture = await getCapturedTabInfo(targetTabId);
  if (!activeCapture) {
    return { ok: true };
  }

  debugWarn('[Background] Detected stale tab capture, attempting cleanup', activeCapture);

  try {
    await offscreenClient.ensureReadyWithRetry(delay);
    await offscreenClient.send<{ ok?: boolean; error?: string }>({
      type: RuntimeMessageType.OFFSCREEN_FORCE_CLEANUP,
    });
  } catch (error) {
    debugWarn('[Background] Offscreen force cleanup failed:', error);
  }

  await delay(250);
  if (!(await getCapturedTabInfo(targetTabId))) {
    return { ok: true };
  }

  try {
    await offscreenClient.forceResetDocument();
  } catch (error) {
    debugWarn('[Background] Offscreen document reset failed:', error);
  }

  await delay(400);
  const remainingCapture = await getCapturedTabInfo(targetTabId);
  if (!remainingCapture) {
    return { ok: true };
  }

  return {
    ok: false,
    detail: `Capture state is still "${remainingCapture.status}".`,
  };
}

function formatCodedStartError(code: string, message: string, detail?: string | null) {
  const nextDetail = typeof detail === 'string' ? detail.trim() : '';
  if (!nextDetail) {
    return `${code}: ${message}`;
  }
  return `${code}: ${message} (${nextDetail})`;
}

function normalizeStartFailureMessage(rawMessage: string | null | undefined) {
  const raw = typeof rawMessage === 'string' ? rawMessage.trim() : '';
  if (!raw) {
    return formatCodedStartError('TAB_CAPTURE_START_FAILED', 'Unable to start recording.');
  }

  if (/^[A-Z0-9_]+:/.test(raw)) {
    return raw;
  }

  const lower = raw.toLowerCase();

  if (
    lower.includes('cannot be captured') ||
    lower.includes('chrome://') ||
    lower.includes('devtools://') ||
    lower.includes('chrome-extension://')
  ) {
    return formatCodedStartError(
      'TAB_NOT_CAPTURABLE',
      'This page cannot be recorded. Open a regular webpage (http/https) and try again.',
      raw,
    );
  }

  if (
    lower.includes('unable to start tab capture') ||
    lower.includes('error starting tab capture') ||
    lower.includes('aborterror')
  ) {
    return formatCodedStartError(
      'TAB_CAPTURE_START_FAILED',
      'Could not attach to the current tab. Refresh the tab and try again.',
      raw,
    );
  }

  if (
    lower.includes('active stream') ||
    lower.includes('already being captured') ||
    lower.includes('capture attached to this tab')
  ) {
    return formatCodedStartError(
      'TAB_CAPTURE_ACTIVE',
      'Chrome still has an active capture attached to this tab.',
      raw,
    );
  }

  if (
    lower.includes('missing tab stream id') ||
    lower.includes('failed to start tab capture') ||
    lower.includes('stream id')
  ) {
    return formatCodedStartError(
      'TAB_CAPTURE_STREAM_UNAVAILABLE',
      'Could not create a capture stream for the current tab.',
      raw,
    );
  }

  if (lower.includes('no active tab')) {
    return formatCodedStartError(
      'TAB_NOT_AVAILABLE',
      'No active tab is available to record. Focus a browser tab and try again.',
      raw,
    );
  }

  return raw;
}

function isTabUrlCapturable(urlString: string): { ok: true } | { ok: false; code: string; message: string } {
  try {
    const parsed = new URL(urlString);
    if (BLOCKED_TAB_CAPTURE_SCHEMES.includes(parsed.protocol)) {
      return {
        ok: false,
        code: 'TAB_NOT_CAPTURABLE',
        message: 'This page cannot be recorded. Open a regular webpage (http/https) and try again.',
      };
    }

    if (BLOCKED_TAB_CAPTURE_HOSTS.has(parsed.hostname)) {
      return {
        ok: false,
        code: 'TAB_NOT_CAPTURABLE',
        message: 'Chrome Web Store pages cannot be recorded. Open another tab and try again.',
      };
    }

    return { ok: true };
  } catch {
    // If URL parsing fails, do not block capture preemptively.
    return { ok: true };
  }
}
