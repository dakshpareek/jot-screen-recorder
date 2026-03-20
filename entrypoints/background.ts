import type {
  AudioPreflightSnapshot,
  OrphanedSession,
  RecoveryChunkCheck,
  ProcessingMetrics,
  RecordingSnapshot,
  RecordingState,
  SystemAudioStatus,
  ValidationResult,
} from '@/lib/recording';

const CONTEXT_KEY = 'phase2-recording-context';

interface PersistedContext {
  state: RecordingState;
  sessionId: string | null;
  recordingStartTime: number | null;
  chunkCount: number;
  processingProgress: number | null;
  errorMessage: string | null;
  storageWarningMessage: string | null;
  outputFileName: string | null;
  validation: ValidationResult | null;
  processingMetrics: ProcessingMetrics | null;
  audioPreflight: AudioPreflightSnapshot;
  orphanedSessions: OrphanedSession[];
  recoverySessionId: string | null;
  recoveryChunks: RecoveryChunkCheck[];
}

type OffscreenResponse = {
  ok: boolean;
  error?: string;
  outputUrl?: string;
  fileName?: string;
  validation?: ValidationResult;
};

type OffscreenEventMessage = {
  type: 'OFFSCREEN_EVENT';
  event:
    | 'CHUNK_WRITTEN'
    | 'FINAL_CHUNK_WRITTEN'
    | 'PROCESS_PROGRESS'
    | 'PROCESS_METRICS'
    | 'ERROR';
  chunkCount?: number;
  progress?: number;
  error?: string;
  metrics?: ProcessingMetrics;
};

type MicPreflightResponse = {
  ok: boolean;
  level?: number;
  error?: string;
};

type RecoveryInspectResponse = {
  ok: boolean;
  error?: string;
  chunks?: RecoveryChunkCheck[];
};

type SystemAudioSignalMessage = {
  type: 'SYSTEM_AUDIO_OK' | 'SYSTEM_AUDIO_SILENT' | 'SYSTEM_AUDIO_ABSENT';
  level?: number;
  error?: string;
};

type StorageSignalMessage = {
  type: 'LOW_STORAGE_WARNING' | 'AUTO_STOP_LOW_STORAGE';
  availableMB?: number;
};

const OFFSCREEN_PING_INITIAL_INTERVAL_MS = 50;
const OFFSCREEN_PING_MAX_INTERVAL_MS = 400;
const OFFSCREEN_PING_TIMEOUT_MS = 3_000;
const PREFLIGHT_RESULT_MIN_VISIBLE_MS = 1_500;

const DEFAULT_AUDIO_PREFLIGHT: AudioPreflightSnapshot = {
  micChecked: false,
  micOk: false,
  micLevel: null,
  micError: null,
  systemAudioStatus: 'idle',
  systemAudioLevel: null,
  systemAudioMessage: null,
  needsSystemAudioDecision: false,
};

const ALLOWED_TRANSITIONS: Record<RecordingState, RecordingState[]> = {
  idle: ['preflight', 'error'],
  preflight: ['armed', 'preflight_error', 'error'],
  preflight_error: ['idle', 'preflight', 'error'],
  armed: ['recording', 'preflight_error', 'idle', 'error'],
  recording: ['audio_warning', 'stopping', 'error'],
  audio_warning: ['recording', 'stopping', 'error'],
  stopping: ['processing', 'error'],
  processing: ['validating', 'error'],
  validating: ['done', 'recovery', 'error'],
  done: ['idle', 'preflight', 'error'],
  recovery: ['idle', 'preflight', 'error'],
  error: ['idle', 'preflight'],
};

let state: RecordingState = 'idle';
let sessionId: string | null = null;
let recordingStartTime: number | null = null;
let chunkCount = 0;
let processingProgress: number | null = null;
let errorMessage: string | null = null;
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
let offscreenReady = false;
let recordingTabId: number | null = null;

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type) return;

    if (message.type === 'GET_STATE') {
      sendResponse(buildSnapshot());
      return;
    }

    if (message.type === 'START') {
      void handleStart().then(sendResponse);
      return true;
    }

    if (message.type === 'PREPARE_START') {
      void handlePrepareStart().then(sendResponse);
      return true;
    }

    if (message.type === 'CANCEL_START') {
      void handleCancelStart().then(sendResponse);
      return true;
    }

    if (message.type === 'STOP') {
      void handleStop().then(sendResponse);
      return true;
    }

    if (message.type === 'DOWNLOAD') {
      void handleDownload().then(sendResponse);
      return true;
    }

    if (message.type === 'SYSTEM_AUDIO_CONTINUE') {
      void handleSystemAudioContinue().then(sendResponse);
      return true;
    }

    if (message.type === 'SYSTEM_AUDIO_STOP_RETRY') {
      void handleSystemAudioStopRetry().then(sendResponse);
      return true;
    }

    if (message.type === 'RECOVER_ORPHAN') {
      const chunkIndexes = Array.isArray(message.chunkIndexes)
        ? message.chunkIndexes
            .map((value: unknown) => Number(value))
            .filter((value: number) => Number.isInteger(value) && value >= 0)
        : undefined;
      void handleRecoverOrphan(String(message.sessionId ?? ''), chunkIndexes).then(sendResponse);
      return true;
    }

    if (message.type === 'DISCARD_ORPHAN') {
      void handleDiscardOrphan(String(message.sessionId ?? '')).then(sendResponse);
      return true;
    }

    if (message.type === 'REFRESH_ORPHANS') {
      void handleRefreshOrphans().then(sendResponse);
      return true;
    }

    if (message.type === 'OPEN_MIC_SETTINGS') {
      void chrome.tabs.create({ url: 'chrome://settings/content/microphone' }).then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === 'OFFSCREEN_EVENT') {
      void handleOffscreenEvent(message as OffscreenEventMessage).then(sendResponse);
      return true;
    }

    if (
      message.type === 'SYSTEM_AUDIO_OK' ||
      message.type === 'SYSTEM_AUDIO_SILENT' ||
      message.type === 'SYSTEM_AUDIO_ABSENT'
    ) {
      void handleSystemAudioSignal(message as SystemAudioSignalMessage).then(sendResponse);
      return true;
    }

    if (message.type === 'LOW_STORAGE_WARNING' || message.type === 'AUTO_STOP_LOW_STORAGE') {
      void handleStorageSignal(message as StorageSignalMessage).then(sendResponse);
      return true;
    }

    if (message.type === 'OFFSCREEN_READY') {
      offscreenReady = true;
      sendResponse({ ok: true });
      return;
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

function normalizeSystemAudioStatus(value: unknown): SystemAudioStatus {
  if (value === 'pending' || value === 'ok' || value === 'absent' || value === 'silent') {
    return value;
  }
  return 'idle';
}

function normalizeAudioPreflight(value: Partial<AudioPreflightSnapshot> | null | undefined) {
  return {
    ...DEFAULT_AUDIO_PREFLIGHT,
    ...(value ?? {}),
    systemAudioStatus: normalizeSystemAudioStatus(value?.systemAudioStatus),
  };
}

async function hydrateContext() {
  try {
    const stored = (await chrome.storage.local.get(CONTEXT_KEY))[CONTEXT_KEY] as
      | PersistedContext
      | undefined;
    if (!stored) return;

    sessionId = stored.sessionId ?? null;
    recordingStartTime = stored.recordingStartTime ?? null;
    chunkCount = stored.chunkCount ?? 0;
    processingProgress = stored.processingProgress ?? null;
    errorMessage = stored.errorMessage ?? null;
    storageWarningMessage = stored.storageWarningMessage ?? null;
    outputFileName = stored.outputFileName ?? null;
    validation = stored.validation ?? null;
    processingMetrics = stored.processingMetrics ?? null;
    audioPreflight = normalizeAudioPreflight(stored.audioPreflight);
    orphanedSessions = Array.isArray(stored.orphanedSessions) ? stored.orphanedSessions : [];
    recoverySessionId = stored.recoverySessionId ?? null;
    recoveryChunks = Array.isArray(stored.recoveryChunks) ? stored.recoveryChunks : [];
    outputUrl = null;

    if (stored.state === 'done') {
      errorMessage = 'Output must be reprocessed before download.';
      setState('recovery', { force: true });
      return;
    }

    setState(stored.state ?? 'idle', { force: true });
  } catch (error) {
    console.error('Failed to hydrate context', error);
    errorMessage = toErrorMessage(error);
    setState('error', { force: true });
  }
}

async function reconcileWithOffscreen() {
  if (!['recording', 'audio_warning', 'stopping', 'processing'].includes(state)) return;

  try {
    const status = await sendToOffscreen<{
      alive?: boolean;
      chunkCount?: number;
      isRecording?: boolean;
    }>({ type: 'OFFSCREEN_STATUS' });

    if (!status?.alive) {
      errorMessage = 'Offscreen recorder is unavailable.';
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
  return ['recording', 'audio_warning', 'stopping', 'processing'].includes(state);
}

async function refreshOrphanedSessions() {
  try {
    await ensureOffscreenReadyWithRetry();
    const result = await sendToOffscreen<{ ok?: boolean; sessions?: OrphanedSession[]; error?: string }>({
      type: 'OFFSCREEN_SCAN_ORPHANS',
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
    (state === 'recording' || state === 'audio_warning') && recordingStartTime
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
    storageWarningMessage,
    canDownload: Boolean(outputUrl) && (state === 'done' || state === 'recovery'),
    outputFileName,
    validation,
    processingMetrics,
    audioPreflight,
    orphanedSessions,
    recoverySessionId,
    recoveryChunks,
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
    audio_warning: { text: '●', color: '#FF3B30' },
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
    storageWarningMessage,
    outputFileName,
    validation,
    processingMetrics,
    audioPreflight,
    orphanedSessions,
    recoverySessionId,
    recoveryChunks,
  };
  await chrome.storage.local.set({ [CONTEXT_KEY]: payload });
}

async function broadcastSnapshot() {
  try {
    await chrome.runtime.sendMessage({
      type: 'STATE_CHANGE',
      snapshot: buildSnapshot(),
    });
  } catch {
    // Popup is usually closed; ignore.
  }
}

async function syncRecordingBanner(next: RecordingState) {
  if (next === 'recording' || next === 'audio_warning') {
    if (recordingTabId === null) return;
    await sendRecordingBanner(recordingTabId, true);
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
      type: 'RECORDING_BANNER',
      visible,
    });
    return true;
  } catch {
    // Content script may be unavailable on browser-internal pages.
    return false;
  }
}

async function handleRecordingTabUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) {
  if (recordingTabId === null || tabId !== recordingTabId) return;
  if (!['recording', 'audio_warning'].includes(state)) return;
  if (changeInfo.status !== 'complete') return;

  const delivered = await sendRecordingBanner(tabId, true);
  if (delivered) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/content.js'],
    });
    await sendRecordingBanner(tabId, true);
  } catch {
    // Tab may still be navigating or disallow script injection.
  }
}

function resetSessionMetadata(nextSessionId: string) {
  sessionId = nextSessionId;
  recordingStartTime = null;
  chunkCount = 0;
  processingProgress = null;
  errorMessage = null;
  storageWarningMessage = null;
  outputFileName = null;
  outputUrl = null;
  validation = null;
  processingMetrics = null;
  recoverySessionId = null;
  recoveryChunks = [];
  audioPreflight = {
    ...audioPreflight,
    systemAudioStatus: 'pending',
    systemAudioLevel: null,
    systemAudioMessage: 'System audio check in progress...',
    needsSystemAudioDecision: false,
  };
}

function resetAttemptMetadata() {
  sessionId = null;
  recordingStartTime = null;
  chunkCount = 0;
  processingProgress = null;
  errorMessage = null;
  storageWarningMessage = null;
  outputFileName = null;
  outputUrl = null;
  validation = null;
  processingMetrics = null;
  recoverySessionId = null;
  recoveryChunks = [];
  audioPreflight = { ...DEFAULT_AUDIO_PREFLIGHT };
}

async function handleStart() {
  if (state !== 'armed') {
    return { ok: false, error: `Cannot start from state "${state}"`, snapshot: buildSnapshot() };
  }

  const nextSessionId = createSessionId();
  resetSessionMetadata(nextSessionId);

  try {
    const targetTabId = await getStartTargetTabId();
    const streamId = await getTabCaptureStreamId(targetTabId);
    if (!streamId) {
      errorMessage = 'Failed to start tab capture.';
      setState('preflight_error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }

    recordingTabId = targetTabId;
    const result = await sendToOffscreen<OffscreenResponse>({
      type: 'OFFSCREEN_START',
      sessionId: nextSessionId,
      streamId,
    });

    if (!result?.ok) {
      recordingTabId = null;
      errorMessage = result?.error ?? 'Failed to start recorder';
      setState('preflight_error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }

    recordingStartTime = Date.now();
    audioPreflight = {
      ...audioPreflight,
      systemAudioStatus: 'pending',
      systemAudioLevel: null,
      systemAudioMessage: 'System audio check in progress...',
      needsSystemAudioDecision: false,
    };
    await persistContext();
    await broadcastSnapshot();
    setState('recording');
    return { ok: true, snapshot: buildSnapshot() };
  } catch (error) {
    recordingTabId = null;
    errorMessage = toErrorMessage(error);
    setState('preflight_error');
    return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
  }
}

async function handlePrepareStart() {
  if (state === 'armed') {
    return { ok: true, snapshot: buildSnapshot() };
  }

  if (!['idle', 'done', 'preflight_error', 'recovery', 'error'].includes(state)) {
    return { ok: false, error: `Cannot prepare from state "${state}"`, snapshot: buildSnapshot() };
  }

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
  try {
    await ensureOffscreenReadyWithRetry();
    const micPreflight = await runMicPreflight();
    audioPreflight = {
      ...audioPreflight,
      micChecked: true,
      micOk: micPreflight.ok,
      micLevel: typeof micPreflight.level === 'number' ? micPreflight.level : null,
      micError: micPreflight.error ?? null,
      systemAudioStatus: 'idle',
      systemAudioLevel: null,
      systemAudioMessage: null,
      needsSystemAudioDecision: false,
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

async function runMicPreflight(): Promise<MicPreflightResponse> {
  try {
    const result = await sendToOffscreen<MicPreflightResponse>({
      type: 'MIC_PREFLIGHT',
    });
    if (!result?.ok) {
      return {
        ok: false,
        error: result?.error ?? 'Microphone pre-flight failed',
      };
    }

    return {
      ok: true,
      level: typeof result.level === 'number' ? result.level : 0,
    };
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
    };
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
    errorMessage = null;
    setState('idle');
  } else if (state === 'preflight') {
    errorMessage = null;
    setState('idle', { force: true });
  }
  return { ok: true, snapshot: buildSnapshot() };
}

async function handleStop() {
  if (!['recording', 'audio_warning'].includes(state)) {
    return { ok: false, error: `Cannot stop from state "${state}"`, snapshot: buildSnapshot() };
  }

  setState('stopping');

  try {
    const result = await sendToOffscreen<OffscreenResponse>({
      type: 'OFFSCREEN_STOP',
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
    setState('error');
    return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
  }
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

async function handleSystemAudioSignal(message: SystemAudioSignalMessage) {
  if (!['recording', 'audio_warning'].includes(state)) {
    return { ok: true };
  }

  if (message.type === 'SYSTEM_AUDIO_OK') {
    audioPreflight = {
      ...audioPreflight,
      systemAudioStatus: 'ok',
      systemAudioLevel: typeof message.level === 'number' ? message.level : null,
      systemAudioMessage: null,
      needsSystemAudioDecision: false,
    };
    errorMessage = null;
    await persistContext();
    await broadcastSnapshot();
    if (state === 'audio_warning') {
      setState('recording');
    }
    return { ok: true };
  }

  const warningMessage =
    message.type === 'SYSTEM_AUDIO_ABSENT'
      ? 'System audio track is missing. Continue with mic only or stop and retry share settings.'
      : 'System audio appears silent after start. Continue with mic only or stop and retry share settings.';

  audioPreflight = {
    ...audioPreflight,
    systemAudioStatus: message.type === 'SYSTEM_AUDIO_ABSENT' ? 'absent' : 'silent',
    systemAudioLevel: typeof message.level === 'number' ? message.level : null,
    systemAudioMessage: warningMessage,
    needsSystemAudioDecision: true,
  };
  errorMessage = warningMessage;

  try {
    await sendToOffscreen<{ ok?: boolean }>({ type: 'OFFSCREEN_PAUSE' });
  } catch {
    // Best-effort pause; keep warning surfaced even if pause fails.
  }

  setState('audio_warning');
  return { ok: true };
}

async function handleSystemAudioContinue() {
  if (state !== 'audio_warning') {
    return { ok: false, error: `Cannot continue from state "${state}"`, snapshot: buildSnapshot() };
  }

  audioPreflight = {
    ...audioPreflight,
    needsSystemAudioDecision: false,
    systemAudioMessage: 'Continuing with microphone audio.',
  };
  errorMessage = null;

  try {
    await sendToOffscreen<{ ok?: boolean }>({ type: 'OFFSCREEN_RESUME' });
  } catch {
    // Resume is best-effort; keep the UI state consistent with user decision.
  }

  setState('recording');
  return { ok: true, snapshot: buildSnapshot() };
}

async function handleSystemAudioStopRetry() {
  if (!['recording', 'audio_warning'].includes(state)) {
    return { ok: false, error: `Cannot stop from state "${state}"`, snapshot: buildSnapshot() };
  }

  audioPreflight = {
    ...audioPreflight,
    needsSystemAudioDecision: false,
    systemAudioMessage: 'Stopped. Retry and enable tab audio in the share dialog.',
  };
  errorMessage = 'System audio was not detected. Recording stopped so you can retry.';
  return await handleStop();
}

async function handleStorageSignal(message: StorageSignalMessage) {
  const availableMB =
    typeof message.availableMB === 'number' && Number.isFinite(message.availableMB)
      ? Math.max(0, message.availableMB)
      : null;

  if (message.type === 'LOW_STORAGE_WARNING') {
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

  if (['recording', 'audio_warning'].includes(state)) {
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
  outputFileName = null;
  outputUrl = null;
  validation = null;
  processingMetrics = null;
  recoverySessionId = null;
  recoveryChunks = [];
  audioPreflight = { ...DEFAULT_AUDIO_PREFLIGHT };
}

async function handleRecoverOrphan(targetSessionId: string, chunkIndexes?: number[]) {
  if (!targetSessionId) {
    return { ok: false, error: 'Missing session id', snapshot: buildSnapshot() };
  }

  if (['preflight', 'armed', 'recording', 'audio_warning', 'stopping', 'processing'].includes(state)) {
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

  const resolvedTarget =
    target ?? orphanedSessions.find((session) => session.sessionId === targetSessionId);
  if (!resolvedTarget) {
    return { ok: false, error: 'Orphaned session not found', snapshot: buildSnapshot() };
  }

  let selectedChunkIndexes = chunkIndexes;
  if (!Array.isArray(selectedChunkIndexes) || !selectedChunkIndexes.length) {
    await ensureOffscreenReadyWithRetry();
    const inspect = await sendToOffscreen<RecoveryInspectResponse>({
      type: 'OFFSCREEN_RECOVERY_INSPECT',
      sessionId: targetSessionId,
    });

    if (!inspect?.ok) {
      return {
        ok: false,
        error: inspect?.error ?? 'Failed to inspect orphaned session chunks',
        snapshot: buildSnapshot(),
      };
    }

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

  primeRecoveredSessionContext(resolvedTarget);
  await persistContext();
  await broadcastSnapshot();

  await runProcessingPipeline({
    targetSessionId: resolvedTarget.sessionId,
    chunkIndexes: selectedChunkIndexes,
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
}

async function handleDiscardOrphan(targetSessionId: string) {
  if (!targetSessionId) {
    return { ok: false, error: 'Missing session id', snapshot: buildSnapshot() };
  }

  try {
    await ensureOffscreenReadyWithRetry();
    const result = await sendToOffscreen<{ ok?: boolean; error?: string }>({
      type: 'OFFSCREEN_CLEAR_SESSION',
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

  if (message.event === 'PROCESS_PROGRESS' && typeof message.progress === 'number') {
    processingProgress = Math.max(0, Math.min(100, Math.floor(message.progress)));
    await persistContext();
    await broadcastSnapshot();
    return { ok: true };
  }

  if (message.event === 'PROCESS_METRICS' && message.metrics) {
    processingMetrics = message.metrics;
    await persistContext();
    await broadcastSnapshot();
    return { ok: true };
  }

  if (message.event === 'ERROR') {
    errorMessage = message.error ?? 'Offscreen pipeline error';
    setState('error');
    return { ok: true };
  }

  if (message.event === 'FINAL_CHUNK_WRITTEN') {
    if (state === 'stopping') {
      // Critical transition: stopping -> processing happens only after OPFS confirms final chunk write.
      await runProcessingPipeline();
    }
    return { ok: true };
  }

  return { ok: true };
}

async function runProcessingPipeline(options?: { targetSessionId?: string; chunkIndexes?: number[] }) {
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
      type: 'OFFSCREEN_PROCESS',
      sessionId: targetSessionId,
    };
    if (Array.isArray(options?.chunkIndexes) && options.chunkIndexes.length) {
      processPayload.chunkIndexes = options.chunkIndexes;
    }

    const processResult = await sendToOffscreen<OffscreenResponse>(processPayload);

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
      (await sendToOffscreen<ValidationResult>({
        type: 'OFFSCREEN_VALIDATE',
      }));

    validation = validationResult ?? null;
    await persistContext();
    await broadcastSnapshot();

    if (!validationResult?.passed) {
      errorMessage = 'Validation failed. Raw chunks remain in OPFS for recovery.';
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

async function ensureOffscreenDoc() {
  if (await chrome.offscreen.hasDocument()) return;

  offscreenReady = false;

  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen-page.html'),
    reasons: [
      'DISPLAY_MEDIA' as chrome.offscreen.Reason,
      'USER_MEDIA' as chrome.offscreen.Reason,
    ],
    justification: 'MediaRecorder for screen capture',
  });
}

async function recreateOffscreenDoc() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    // Ignore close failures and retry creation.
  }

  offscreenReady = false;
  await ensureOffscreenDoc();
}

async function ensureOffscreenReadyWithRetry() {
  try {
    await ensureOffscreenDoc();
    await waitForOffscreenReady();
  } catch {
    await recreateOffscreenDoc();
    await waitForOffscreenReady();
  }
}

async function getStartTargetTabId() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  if (!activeTab?.id) {
    throw new Error('No active tab available for capture.');
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

async function waitForOffscreenReady(timeoutMs = OFFSCREEN_PING_TIMEOUT_MS) {
  if (offscreenReady) return;

  const deadline = Date.now() + timeoutMs;
  let delayMs = OFFSCREEN_PING_INITIAL_INTERVAL_MS;

  while (Date.now() < deadline) {
    if (offscreenReady) return;

    try {
      const status = await sendToOffscreen<{ alive?: boolean }>({ type: 'OFFSCREEN_STATUS' });
      if (status?.alive) {
        offscreenReady = true;
        return;
      }
    } catch {
      // Message port is not ready yet; retry with backoff.
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    await delay(Math.min(delayMs, remainingMs));
    delayMs = Math.min(delayMs * 2, OFFSCREEN_PING_MAX_INTERVAL_MS);
  }

  throw new Error(`Offscreen document did not become ready within ${timeoutMs}ms`);
}

async function sendToOffscreen<T>(message: Record<string, unknown>): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

function createSessionId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `rec_${y}${m}${d}_${hh}${mm}${ss}`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}
