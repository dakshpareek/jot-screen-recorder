import type {
  ProcessingMetrics,
  RecordingSnapshot,
  RecordingState,
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
  outputFileName: string | null;
  validation: ValidationResult | null;
  processingMetrics: ProcessingMetrics | null;
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

const OFFSCREEN_PING_INITIAL_INTERVAL_MS = 50;
const OFFSCREEN_PING_MAX_INTERVAL_MS = 400;
const OFFSCREEN_PING_TIMEOUT_MS = 3_000;

const ALLOWED_TRANSITIONS: Record<RecordingState, RecordingState[]> = {
  idle: ['preflight', 'error'],
  preflight: ['armed', 'preflight_error', 'error'],
  preflight_error: ['idle', 'preflight', 'error'],
  armed: ['recording', 'preflight_error', 'idle', 'error'],
  recording: ['stopping', 'error'],
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
let outputFileName: string | null = null;
let outputUrl: string | null = null;
let validation: ValidationResult | null = null;
let processingMetrics: ProcessingMetrics | null = null;
let processingPipelineRunning = false;
let offscreenReady = false;

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

    if (message.type === 'STOP') {
      void handleStop().then(sendResponse);
      return true;
    }

    if (message.type === 'DOWNLOAD') {
      void handleDownload().then(sendResponse);
      return true;
    }

    if (message.type === 'OFFSCREEN_EVENT') {
      void handleOffscreenEvent(message as OffscreenEventMessage).then(sendResponse);
      return true;
    }

    if (message.type === 'OFFSCREEN_READY') {
      offscreenReady = true;
      sendResponse({ ok: true });
      return;
    }
  });

  void bootstrap();
});

async function bootstrap() {
  await hydrateContext();
  await reconcileWithOffscreen();
  await broadcastSnapshot();
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
    outputFileName = stored.outputFileName ?? null;
    validation = stored.validation ?? null;
    processingMetrics = stored.processingMetrics ?? null;
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
  if (!['recording', 'stopping', 'processing'].includes(state)) return;

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
    canDownload: Boolean(outputUrl) && (state === 'done' || state === 'recovery'),
    outputFileName,
    validation,
    processingMetrics,
  };
}

function setState(next: RecordingState, options?: { force?: boolean }) {
  if (next === state) {
    updateBadge(next);
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
  void persistContext();
  void broadcastSnapshot();
}

function updateBadge(next: RecordingState) {
  const badges: Partial<Record<RecordingState, { text: string; color: string }>> = {
    recording: { text: '●', color: '#FF3B30' },
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
    outputFileName,
    validation,
    processingMetrics,
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

function resetSessionMetadata(nextSessionId: string) {
  sessionId = nextSessionId;
  recordingStartTime = null;
  chunkCount = 0;
  processingProgress = null;
  errorMessage = null;
  outputFileName = null;
  outputUrl = null;
  validation = null;
  processingMetrics = null;
}

async function handleStart() {
  if (!['idle', 'done', 'preflight_error', 'recovery', 'error'].includes(state)) {
    return { ok: false, error: `Cannot start from state "${state}"`, snapshot: buildSnapshot() };
  }

  setState('preflight');

  try {
    await ensureOffscreenReadyWithRetry();
  } catch (error) {
    errorMessage = toErrorMessage(error);
    setState('preflight_error');
    return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
  }

  const nextSessionId = createSessionId();
  resetSessionMetadata(nextSessionId);

  try {
    setState('armed');
    const targetTabId = await getStartTargetTabId();
    const streamId = await getTabCaptureStreamId(targetTabId);

    if (!streamId) {
      errorMessage = 'Screen share was canceled.';
      setState('preflight_error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }

    const result = await sendToOffscreen<OffscreenResponse>({
      type: 'OFFSCREEN_START',
      sessionId: nextSessionId,
      streamId,
    });

    if (!result?.ok) {
      errorMessage = result?.error ?? 'Failed to start recorder';
      setState('preflight_error');
      return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
    }

    recordingStartTime = Date.now();
    await persistContext();
    await broadcastSnapshot();
    setState('recording');
    return { ok: true, snapshot: buildSnapshot() };
  } catch (error) {
    errorMessage = toErrorMessage(error);
    setState('preflight_error');
    return { ok: false, error: errorMessage, snapshot: buildSnapshot() };
  }
}

async function handleStop() {
  if (state !== 'recording') {
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

async function runProcessingPipeline() {
  if (processingPipelineRunning) return;
  if (!sessionId) {
    errorMessage = 'Missing session id for processing';
    setState('error');
    return;
  }

  processingPipelineRunning = true;
  try {
    processingProgress = 0;
    setState('processing');

    const processResult = await sendToOffscreen<OffscreenResponse>({
      type: 'OFFSCREEN_PROCESS',
      sessionId,
    });

    if (!processResult?.ok || !processResult.outputUrl) {
      errorMessage = processResult?.error ?? 'MP4 processing failed';
      setState('error');
      return;
    }

    outputUrl = processResult.outputUrl;
    outputFileName = processResult.fileName ?? `${sessionId}.mp4`;
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
  const activeTabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const targetTab = activeTabs[0];

  if (!targetTab?.id) {
    throw new Error('No active tab available for capture.');
  }
  return targetTab.id;
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
