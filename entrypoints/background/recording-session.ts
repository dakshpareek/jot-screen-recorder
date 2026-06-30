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
  TestOrphanFixture,
  TestPermissionState,
} from '@/lib/messages';
import { OffscreenEventType, RuntimeMessageType } from '@/lib/messages';
import { debugWarn } from '@/lib/runtime-log';
import { buildTestCaptureStreamId } from '@/lib/testing/capture-stream';
import { ALLOWED_TRANSITIONS } from './state/transitions';
import type {
  EncoderBackend,
  PersistedContext,
  RecorderSettings,
} from './state/persisted-context';
import type { OffscreenClient } from './services/offscreen-client';
import {
  buildDownloadFileName,
  buildExportBaseName,
  createSessionId,
  getSystemAudioPreflightSnapshot,
  normalizeCaptureQuality,
  normalizeResolvedCaptureQuality,
  normalizeSystemAudioStatus,
  toErrorMessage,
} from './utils';

type RawDownloadItem = {
  url: string;
  filename: string;
};

const PREFLIGHT_RESULT_MIN_VISIBLE_MS = 1_500;
const BLOCKED_TAB_CAPTURE_SCHEMES = ['chrome:', 'chrome-extension:', 'devtools:', 'edge:', 'about:'];
const BLOCKED_TAB_CAPTURE_HOSTS = new Set(['chromewebstore.google.com']);

export const DEFAULT_AUDIO_PREFLIGHT: AudioPreflightSnapshot = {
  micChecked: false,
  micOk: false,
  micLevel: null,
  micError: null,
  systemAudioStatus: 'idle',
  systemAudioLevel: null,
};

/**
 * Everything the recording lifecycle touches that is not pure state. The aggregate
 * owns the state and the transition/snapshot/persist logic; all Chrome / OS coupling
 * is injected here so the lifecycle can be driven against a fake — no browser.
 */
export interface RecordingSessionDeps {
  offscreen: Pick<
    OffscreenClient,
    'send' | 'ensureReadyWithRetry' | 'forceResetDocument' | 'markReady'
  >;
  delay(ms: number): Promise<void>;
  // side-effect sinks (setState fan-out)
  persist(context: PersistedContext): Promise<void>;
  broadcast(snapshot: RecordingSnapshot): Promise<void>;
  setBadge(state: RecordingState): void;
  showRecordingBanner(tabId: number): Promise<void>;
  hideRecordingBanner(tabId: number): Promise<void>;
  // platform reads / capture
  loadRecorderSettings(): Promise<RecorderSettings>;
  estimateStorage(): Promise<StorageEstimate>;
  resolveMicPermissionState(): Promise<TestPermissionState | PermissionState | null>;
  isTestControlPlaneEnabled(): boolean;
  getTestActiveTabFixture(): Promise<chrome.tabs.Tab | null>;
  queryActiveTab(): Promise<chrome.tabs.Tab | undefined>;
  activateTab(tabId: number): Promise<void>;
  getCaptureStreamId(tabId: number): Promise<string>;
  getCapturedTabInfo(tabId: number): Promise<chrome.tabCapture.CaptureInfo | null>;
  download(options: chrome.downloads.DownloadOptions): Promise<number>;
}

export class RecordingSession {
  private state: RecordingState = 'idle';
  private sessionId: string | null = null;
  private recordingStartTime: number | null = null;
  private chunkCount = 0;
  private processingProgress: number | null = null;
  private errorMessage: string | null = null;
  private micWarningMessage: string | null = null;
  private storageWarningMessage: string | null = null;
  private _outputFileName: string | null = null;
  private outputUrl: string | null = null;
  private validation: ValidationResult | null = null;
  private processingMetrics: ProcessingMetrics | null = null;
  private audioPreflight: AudioPreflightSnapshot = { ...DEFAULT_AUDIO_PREFLIGHT };
  private orphanedSessions: OrphanedSession[] = [];
  private recoverySessionId: string | null = null;
  private recoveryChunks: RecoveryChunkCheck[] = [];
  private processingPipelineRunning = false;
  private recordingTabId: number | null = null;
  private activeAudioSource: AudioSource = 'both';
  private selectedMicDeviceId: string | null = null;
  private recordingQuality: CaptureQuality = 'auto';
  private resolvedPreset: CaptureResolvedQuality | null = null;
  private activeEncoderBackend: EncoderBackend = 'webcodecs';
  private webCodecsStats: RecordingSnapshot['webCodecsStats'] = null;

  constructor(private readonly deps: RecordingSessionDeps) {}

  /** Last computed output file name — consumed by the test control-plane debug hook. */
  get outputFileName(): string | null {
    return this._outputFileName;
  }

  snapshot(): RecordingSnapshot {
    const elapsedSeconds =
      this.state === 'recording' && this.recordingStartTime
        ? Math.max(0, Math.floor((Date.now() - this.recordingStartTime) / 1000))
        : 0;

    return {
      state: this.state,
      sessionId: this.sessionId,
      recordingStartTime: this.recordingStartTime,
      elapsedSeconds,
      chunkCount: this.chunkCount,
      processingProgress: this.processingProgress,
      errorMessage: this.errorMessage,
      micWarningMessage: this.micWarningMessage,
      storageWarningMessage: this.storageWarningMessage,
      canDownload: Boolean(this.outputUrl) && (this.state === 'done' || this.state === 'recovery'),
      outputFileName: this._outputFileName,
      requestedPreset: this.recordingQuality,
      resolvedPreset: this.resolvedPreset,
      recordingQuality: this.recordingQuality,
      validation: this.validation,
      processingMetrics: this.processingMetrics,
      audioPreflight: this.audioPreflight,
      orphanedSessions: this.orphanedSessions,
      recoverySessionId: this.recoverySessionId,
      recoveryChunks: this.recoveryChunks,
      webCodecsStats: this.webCodecsStats,
    };
  }

  toPersisted(): PersistedContext {
    return {
      state: this.state,
      sessionId: this.sessionId,
      recordingStartTime: this.recordingStartTime,
      chunkCount: this.chunkCount,
      processingProgress: this.processingProgress,
      errorMessage: this.errorMessage,
      micWarningMessage: this.micWarningMessage,
      storageWarningMessage: this.storageWarningMessage,
      outputFileName: this._outputFileName,
      requestedPreset: this.recordingQuality,
      resolvedPreset: this.resolvedPreset,
      recordingQuality: this.recordingQuality,
      validation: this.validation,
      processingMetrics: this.processingMetrics,
      audioPreflight: this.audioPreflight,
      orphanedSessions: this.orphanedSessions,
      recoverySessionId: this.recoverySessionId,
      recoveryChunks: this.recoveryChunks,
      webCodecsStats: this.webCodecsStats,
    };
  }

  /** Restore from a previously persisted context. Mirrors the legacy hydrateContext body. */
  hydrate(stored: PersistedContext) {
    this.sessionId = stored.sessionId ?? null;
    this.recordingStartTime = stored.recordingStartTime ?? null;
    this.chunkCount = stored.chunkCount ?? 0;
    this.processingProgress = stored.processingProgress ?? null;
    this.errorMessage = stored.errorMessage ?? null;
    this.micWarningMessage = stored.micWarningMessage ?? null;
    this.storageWarningMessage = stored.storageWarningMessage ?? null;
    this._outputFileName = stored.outputFileName ?? null;
    this.validation = stored.validation ?? null;
    this.processingMetrics = stored.processingMetrics ?? null;
    this.audioPreflight = this.normalizeAudioPreflight(stored.audioPreflight);
    this.orphanedSessions = Array.isArray(stored.orphanedSessions) ? stored.orphanedSessions : [];
    this.recoverySessionId = stored.recoverySessionId ?? null;
    this.recoveryChunks = Array.isArray(stored.recoveryChunks) ? stored.recoveryChunks : [];
    this.recordingQuality = normalizeCaptureQuality(stored.requestedPreset ?? stored.recordingQuality);
    this.resolvedPreset =
      stored.resolvedPreset == null ? null : normalizeResolvedCaptureQuality(stored.resolvedPreset);
    this.activeEncoderBackend = stored.usingWebCodecs === false ? 'mediarecorder' : 'webcodecs';
    this.webCodecsStats = stored.webCodecsStats ?? null;
    this.outputUrl = null;

    if (stored.state === 'done') {
      this.errorMessage = 'Output must be reprocessed before download.';
      this.setState('recovery', { force: true });
      return;
    }

    // WebCodecs uses OPFS (webcodecs-stream.mp4 + manifest); after SW restart,
    // reconcileWithOffscreen moves to recovery so the user can reprocess like MediaRecorder orphans.

    this.setState(stored.state ?? 'idle', { force: true });
  }

  /** Mark hydration as failed (storage load threw) — mirrors the legacy catch branch. */
  failHydration(error: unknown) {
    this.errorMessage = toErrorMessage(error);
    this.setState('error', { force: true });
  }

  private setState(next: RecordingState, options?: { force?: boolean }) {
    if (next === this.state) {
      this.deps.setBadge(next);
      void this.syncRecordingBanner(next);
      void this.deps.persist(this.toPersisted());
      void this.deps.broadcast(this.snapshot());
      return;
    }

    if (!options?.force && !ALLOWED_TRANSITIONS[this.state].includes(next)) {
      console.warn(`Blocked invalid transition ${this.state} -> ${next}`);
      return;
    }

    this.state = next;
    this.deps.setBadge(next);
    void this.syncRecordingBanner(next);
    void this.deps.persist(this.toPersisted());
    void this.deps.broadcast(this.snapshot());
  }

  private async syncRecordingBanner(next: RecordingState) {
    if (next === 'recording') {
      if (this.recordingTabId === null) return;
      await this.deps.showRecordingBanner(this.recordingTabId);
      return;
    }

    if (this.recordingTabId === null) return;
    const targetTabId = this.recordingTabId;
    this.recordingTabId = null;
    await this.deps.hideRecordingBanner(targetTabId);
  }

  private normalizeAudioPreflight(value: Partial<AudioPreflightSnapshot> | null | undefined) {
    return {
      ...DEFAULT_AUDIO_PREFLIGHT,
      ...(value ?? {}),
      systemAudioStatus: normalizeSystemAudioStatus(value?.systemAudioStatus),
    };
  }

  private isUsingWebCodecsBackend() {
    return this.activeEncoderBackend === 'webcodecs';
  }

  private hasActiveRuntimeRecording() {
    return ['recording', 'stopping', 'processing'].includes(this.state);
  }

  async reconcileWithOffscreen() {
    if (!['recording', 'stopping', 'processing'].includes(this.state)) return;

    try {
      const status = await this.deps.offscreen.send<{
        alive?: boolean;
        chunkCount?: number;
        isRecording?: boolean;
        isWebCodecsRecording?: boolean;
      }>({ type: RuntimeMessageType.OFFSCREEN_STATUS });

      if (!status?.alive) {
        this.errorMessage = 'Offscreen recorder is unavailable.';
        this.setState('recovery', { force: true });
        return;
      }

      const captureLive = status.isRecording === true || status.isWebCodecsRecording === true;
      if (this.state === 'recording' && !captureLive) {
        this.errorMessage = 'Recording session was lost.';
        this.setState('recovery', { force: true });
        return;
      }

      if (typeof status.chunkCount === 'number') {
        this.chunkCount = Math.max(this.chunkCount, status.chunkCount);
        await this.deps.persist(this.toPersisted());
      }
    } catch {
      this.errorMessage = 'Unable to reconnect to offscreen recorder.';
      this.setState('recovery', { force: true });
    }
  }

  async refreshOrphanedSessions() {
    try {
      await this.deps.offscreen.ensureReadyWithRetry(this.deps.delay);
      const result = await this.deps.offscreen.send<{ ok?: boolean; sessions?: OrphanedSession[]; error?: string }>({
        type: RuntimeMessageType.OFFSCREEN_SCAN_ORPHANS,
      });

      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      this.orphanedSessions = sessions.filter((session) => {
        if (!this.hasActiveRuntimeRecording()) return true;
        if (!this.sessionId) return true;
        return session.sessionId !== this.sessionId;
      });
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());
    } catch {
      // Keep the last known orphan list when scan is unavailable.
    }
  }

  async syncOrphanFixture(previousFixture: TestOrphanFixture, nextFixture: TestOrphanFixture) {
    const previousSessionIds = new Set(previousFixture.sessions.map((session) => session.sessionId));
    const nextSessionIds = new Set(nextFixture.sessions.map((session) => session.sessionId));

    try {
      await this.deps.offscreen.ensureReadyWithRetry(this.deps.delay);

      for (const sessionIdToClear of previousSessionIds) {
        if (nextSessionIds.has(sessionIdToClear)) continue;
        await this.deps.offscreen.send<{ ok?: boolean; error?: string }>({
          type: RuntimeMessageType.OFFSCREEN_CLEAR_SESSION,
          sessionId: sessionIdToClear,
        });
      }

      if (nextFixture.sessions.length > 0) {
        await this.deps.offscreen.send<{ ok?: boolean; error?: string }>({
          type: RuntimeMessageType.OFFSCREEN_TEST_SEED_ORPHANS,
          sessions: nextFixture.sessions,
        });
      }
    } catch (error) {
      debugWarn('[Background] Failed to sync test orphan fixture:', error);
    }

    await this.refreshOrphanedSessions();
    return { ok: true, snapshot: this.snapshot() };
  }

  private resetSessionMetadata(nextSessionId: string) {
    this.sessionId = nextSessionId;
    this.recordingStartTime = null;
    this.chunkCount = 0;
    this.processingProgress = null;
    this.errorMessage = null;
    this.micWarningMessage = null;
    this.storageWarningMessage = null;
    this._outputFileName = null;
    this.outputUrl = null;
    this.validation = null;
    this.processingMetrics = null;
    this.recoverySessionId = null;
    this.recoveryChunks = [];
    this.webCodecsStats = null;
    this.resolvedPreset = null;
    this.audioPreflight = {
      ...this.audioPreflight,
      systemAudioStatus: 'idle',
      systemAudioLevel: null,
    };
  }

  private resetAttemptMetadata() {
    this.sessionId = null;
    this.recordingStartTime = null;
    this.chunkCount = 0;
    this.processingProgress = null;
    this.errorMessage = null;
    this.micWarningMessage = null;
    this.storageWarningMessage = null;
    this._outputFileName = null;
    this.outputUrl = null;
    this.validation = null;
    this.processingMetrics = null;
    this.recoverySessionId = null;
    this.recoveryChunks = [];
    this.audioPreflight = { ...DEFAULT_AUDIO_PREFLIGHT };
    this.activeAudioSource = 'both';
    this.selectedMicDeviceId = null;
    this.resolvedPreset = null;
    this.webCodecsStats = null;
  }

  async start(
    audioSource: AudioSource = 'both',
    micDeviceId: string | null = null,
    quality: CaptureQuality = 'auto',
  ) {
    if (this.state !== 'armed') {
      return { ok: false, error: `Cannot start from state "${this.state}"`, snapshot: this.snapshot() };
    }

    this.activeAudioSource = audioSource;
    this.selectedMicDeviceId = audioSource === 'both' || audioSource === 'mic' ? micDeviceId : null;
    this.recordingQuality = normalizeCaptureQuality(quality);
    this.resolvedPreset = null;
    const recordingStartedAt = Date.now();
    const nextSessionId = createSessionId(recordingStartedAt);
    this.resetSessionMetadata(nextSessionId);

    // Encoder backend is productized settings now (WebCodecs default, legacy optional).
    const recorderSettings = await this.deps.loadRecorderSettings();
    this.activeEncoderBackend = recorderSettings.encoderBackend;

    try {
      const targetTab = await this.getStartTargetTab();
      const targetTabId = targetTab.id!;
      const testCaptureFixture = this.deps.isTestControlPlaneEnabled()
        ? await this.deps.getTestActiveTabFixture()
        : null;
      const useTestCaptureStream = testCaptureFixture?.id === targetTabId;
      if (this.deps.isTestControlPlaneEnabled()) {
        if (useTestCaptureStream) {
          try {
            await this.deps.activateTab(targetTabId);
          } catch {
            // Best-effort: the active-tab capture grant is only needed for test flows.
          }
        }
      }
      const staleCaptureRecovery = await this.releaseStaleTabCapture(targetTabId);
      if (!staleCaptureRecovery.ok) {
        this.errorMessage = formatCodedStartError(
          'TAB_CAPTURE_ACTIVE',
          'Chrome still has an active capture attached to this tab. Stop the current share and try again.',
          staleCaptureRecovery.detail,
        );
        this.setState('preflight_error');
        return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
      }

      let streamId = useTestCaptureStream
        ? buildTestCaptureStreamId(targetTabId)
        : await this.deps.getCaptureStreamId(targetTabId);
      if (!streamId) {
        this.errorMessage = formatCodedStartError(
          'TAB_CAPTURE_STREAM_UNAVAILABLE',
          'Could not create a capture stream for the current tab. Reload the tab and try again.',
        );
        this.setState('preflight_error');
        return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
      }

      this.recordingTabId = targetTabId;
      const exportBaseName = buildExportBaseName({
        timestampMs: recordingStartedAt,
        title: targetTab.title,
        url: targetTab.url,
      });

      let result: OffscreenResponse;
      const startMediaRecorder = async () =>
        await this.deps.offscreen.send<OffscreenResponse>({
          type: RuntimeMessageType.OFFSCREEN_START,
          sessionId: nextSessionId,
          streamId,
          audioSource,
          micDeviceId: this.selectedMicDeviceId,
          quality: this.recordingQuality,
          exportBaseName,
          recordingStartTime: recordingStartedAt,
        });

      if (this.isUsingWebCodecsBackend()) {
        // 4.1: WebCodecs primary path with automatic MediaRecorder fallback.
        let webCodecsError: string | null = null;
        try {
          const webCodecsResult = await this.deps.offscreen.send<OffscreenResponse>({
            type: RuntimeMessageType.OFFSCREEN_START_WEBCODECS,
            sessionId: nextSessionId,
            streamId,
            quality: this.recordingQuality,
            audioSource,
            micDeviceId: this.selectedMicDeviceId,
            exportBaseName,
            recordingStartTime: recordingStartedAt,
          });
          if (webCodecsResult?.ok) {
            result = webCodecsResult;
          } else {
            webCodecsError = webCodecsResult?.error ?? 'Unknown WebCodecs start failure';
            debugWarn('[Background] WebCodecs start failed; falling back to MediaRecorder:', webCodecsError);
            this.activeEncoderBackend = 'mediarecorder';
            const staleCaptureRecovery = await this.releaseStaleTabCapture(targetTabId);
            if (!staleCaptureRecovery.ok) {
              result = {
                ok: false,
                error: `WebCodecs start failed (${webCodecsError}). MediaRecorder fallback also failed: ${staleCaptureRecovery.detail ?? 'Unable to release stale tab capture'}`,
              };
            } else {
              streamId = useTestCaptureStream
                ? buildTestCaptureStreamId(targetTabId)
                : await this.deps.getCaptureStreamId(targetTabId);
              const fallback = await startMediaRecorder();
              result =
                fallback?.ok || !fallback
                  ? fallback
                  : {
                      ...fallback,
                      error: `WebCodecs start failed (${webCodecsError}). MediaRecorder fallback also failed: ${fallback.error ?? 'Unknown fallback failure'}`,
                    };
            }
          }
        } catch (error) {
          webCodecsError = toErrorMessage(error);
          debugWarn('[Background] WebCodecs start threw; falling back to MediaRecorder:', webCodecsError);
          this.activeEncoderBackend = 'mediarecorder';
          const staleCaptureRecovery = await this.releaseStaleTabCapture(targetTabId);
          if (!staleCaptureRecovery.ok) {
            result = {
              ok: false,
              error: `WebCodecs start failed (${webCodecsError}). MediaRecorder fallback also failed: ${staleCaptureRecovery.detail ?? 'Unable to release stale tab capture'}`,
            };
          } else {
            streamId = useTestCaptureStream
              ? buildTestCaptureStreamId(targetTabId)
              : await this.deps.getCaptureStreamId(targetTabId);
            const fallback = await startMediaRecorder();
            result =
              fallback?.ok || !fallback
                ? fallback
                : {
                    ...fallback,
                    error: `WebCodecs start failed (${webCodecsError}). MediaRecorder fallback also failed: ${fallback.error ?? 'Unknown fallback failure'}`,
                  };
          }
        }
      } else {
        result = await startMediaRecorder();
      }

      if (!result?.ok) {
        this.recordingTabId = null;
        this.errorMessage = normalizeStartFailureMessage(result?.error ?? 'Failed to start recorder');
        this.setState('preflight_error');
        return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
      }

      this.recordingQuality = normalizeCaptureQuality(result.requestedPreset ?? this.recordingQuality);
      this.resolvedPreset =
        result.resolvedPreset == null ? null : normalizeResolvedCaptureQuality(result.resolvedPreset);

      this.recordingStartTime = recordingStartedAt;
      this._outputFileName = buildDownloadFileName(
        exportBaseName,
        result.outputMimeType ?? (String(result.fileName ?? '').endsWith('.webm') ? 'video/webm' : 'video/mp4'),
      );
      this.audioPreflight = {
        ...this.audioPreflight,
        ...getSystemAudioPreflightSnapshot(this.activeAudioSource, this.isUsingWebCodecsBackend()),
      };
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());
      this.setState('recording');
      return { ok: true, snapshot: this.snapshot() };
    } catch (error) {
      this.recordingTabId = null;
      this.errorMessage = normalizeStartFailureMessage(toErrorMessage(error));
      this.setState('preflight_error');
      return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
    }
  }

  async prepareStart(
    includeMic = true,
    micDeviceId: string | null = null,
    quality: CaptureQuality = 'auto',
  ) {
    try {
      if (this.state === 'armed') {
        this.recordingQuality = normalizeCaptureQuality(quality);
        this.resolvedPreset = null;
        await this.deps.persist(this.toPersisted());
        await this.deps.broadcast(this.snapshot());
        return { ok: true, snapshot: this.snapshot() };
      }

      if (!['idle', 'done', 'preflight_error', 'recovery', 'error'].includes(this.state)) {
        return { ok: false, error: `Cannot prepare from state "${this.state}"`, snapshot: this.snapshot() };
      }

      this.recordingQuality = normalizeCaptureQuality(quality);
      this.resolvedPreset = null;
      this.resetAttemptMetadata();
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());

      const storageCheck = await this.checkStorageQuota();
      this.storageWarningMessage = storageCheck.warningMessage ?? null;
      if (!storageCheck.ok) {
        this.errorMessage = storageCheck.warningMessage ?? 'Insufficient storage to start recording';
        this.setState('preflight_error');
        return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
      }

      this.setState('preflight');
      const preflightStartedAt = Date.now();

      const targetTab = await this.getStartTargetTab({ validateCapturable: false });
      const targetTabId = targetTab.id!;
      const staleCaptureRecovery = await this.releaseStaleTabCapture(targetTabId);
      if (!staleCaptureRecovery.ok) {
        this.errorMessage = formatCodedStartError(
          'TAB_CAPTURE_ACTIVE',
          'Chrome still has an active capture attached to this tab. Stop the current share and try again.',
          staleCaptureRecovery.detail,
        );
        this.setState('preflight_error');
        return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
      }

      await this.deps.offscreen.ensureReadyWithRetry(this.deps.delay);

      if (!includeMic) {
        this.selectedMicDeviceId = null;
        this.audioPreflight = {
          ...this.audioPreflight,
          micChecked: true,
          micOk: true,
          micLevel: null,
          micError: null,
          systemAudioStatus: 'idle',
          systemAudioLevel: null,
        };
        this.errorMessage = null;
        await this.deps.persist(this.toPersisted());
        await this.deps.broadcast(this.snapshot());
        this.setState('armed');
        return { ok: true, snapshot: this.snapshot() };
      }

      this.selectedMicDeviceId = micDeviceId;
      const micPreflight = await this.runMicPreflight(this.selectedMicDeviceId);
      this.audioPreflight = {
        ...this.audioPreflight,
        micChecked: true,
        micOk: micPreflight.ok,
        micLevel: typeof micPreflight.level === 'number' ? micPreflight.level : null,
        micError: micPreflight.error ?? null,
        systemAudioStatus: 'idle',
        systemAudioLevel: null,
      };
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());

      const visibleMs = Date.now() - preflightStartedAt;
      if (visibleMs < PREFLIGHT_RESULT_MIN_VISIBLE_MS) {
        await this.deps.delay(PREFLIGHT_RESULT_MIN_VISIBLE_MS - visibleMs);
      }

      if (!micPreflight.ok) {
        this.errorMessage = micPreflight.error ?? 'Microphone pre-flight failed';
        this.setState('preflight_error');
        return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
      }
      this.errorMessage = null;
      this.setState('armed');
      return { ok: true, snapshot: this.snapshot() };
    } catch (error) {
      this.errorMessage = toErrorMessage(error);
      this.setState('preflight_error');
      return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
    }
  }

  private async runMicPreflight(micDeviceId: string | null = null): Promise<MicPreflightResponse> {
    try {
      const permissionState = await this.deps.resolveMicPermissionState();
      const payload: Record<string, unknown> = { type: RuntimeMessageType.MIC_PREFLIGHT };
      if (micDeviceId) {
        payload.micDeviceId = micDeviceId;
      }
      if (permissionState) {
        payload.permissionState = permissionState;
      }
      const result = await this.deps.offscreen.send<MicPreflightResponse>(payload);
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

  async runMicCheck(micDeviceId: string | null = null) {
    if (!['idle', 'done', 'preflight_error', 'recovery', 'error'].includes(this.state)) {
      return {
        ok: false,
        error: `Cannot check microphone from state "${this.state}"`,
        snapshot: this.snapshot(),
      };
    }

    this.selectedMicDeviceId = micDeviceId;
    const micPreflight = await this.runMicPreflight(this.selectedMicDeviceId);
    this.audioPreflight = {
      ...this.audioPreflight,
      micChecked: true,
      micOk: micPreflight.ok,
      micLevel: typeof micPreflight.level === 'number' ? micPreflight.level : null,
      micError: micPreflight.error ?? null,
    };
    if (micPreflight.ok) {
      this.micWarningMessage = null;
    }

    await this.deps.persist(this.toPersisted());
    await this.deps.broadcast(this.snapshot());
    return {
      ok: micPreflight.ok,
      level: micPreflight.level,
      deviceLabel: micPreflight.deviceLabel ?? null,
      error: micPreflight.error,
      snapshot: this.snapshot(),
    };
  }

  async releaseMicCheck() {
    await this.releasePreflightMicHold();
    this.audioPreflight = {
      ...this.audioPreflight,
      micChecked: false,
      micOk: false,
      micLevel: null,
      micError: null,
    };
    this.micWarningMessage = null;
    await this.deps.persist(this.toPersisted());
    await this.deps.broadcast(this.snapshot());
    return { ok: true, snapshot: this.snapshot() };
  }

  private async releasePreflightMicHold() {
    try {
      await this.deps.offscreen.ensureReadyWithRetry(this.deps.delay);
      await this.deps.offscreen.send<{ ok?: boolean }>({
        type: RuntimeMessageType.OFFSCREEN_RELEASE_PREFLIGHT_MIC,
      });
    } catch {
      // Best-effort cleanup for any preflight-held mic stream.
    }
  }

  private async checkStorageQuota() {
    try {
      const estimate = await this.deps.estimateStorage();
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

  async cancelStart() {
    if (this.state === 'armed') {
      await this.releasePreflightMicHold();
      this.errorMessage = null;
      this.setState('idle');
    } else if (this.state === 'preflight') {
      await this.releasePreflightMicHold();
      this.errorMessage = null;
      this.setState('idle', { force: true });
    }
    return { ok: true, snapshot: this.snapshot() };
  }

  async stop() {
    if (this.state !== 'recording') {
      return { ok: false, error: `Cannot stop from state "${this.state}"`, snapshot: this.snapshot() };
    }

    this.setState('stopping');

    try {
      if (this.isUsingWebCodecsBackend()) {
        // WebCodecs path: stop returns the final MP4 directly, no processing needed
        const result = await this.deps.offscreen.send<OffscreenResponse & {
          outputSize?: number;
          stopDurationMs?: number;
        }>({
          type: RuntimeMessageType.OFFSCREEN_STOP_WEBCODECS,
        });

        if (!result?.ok) {
          this.errorMessage = result?.error ?? 'Failed to stop WebCodecs recorder';
          this.activeEncoderBackend = 'webcodecs';
          this.setState('error');
          return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
        }

        // WebCodecs returns the output directly - skip processing
        this.outputUrl = result.outputUrl ?? null;
        this._outputFileName = this._outputFileName ?? buildDownloadFileName(this.sessionId, result.outputMimeType ?? 'video/mp4');
        this.validation = result.validation ?? null;
        this.processingProgress = 100;

        this.activeEncoderBackend = 'webcodecs';
        await this.deps.persist(this.toPersisted());
        await this.deps.broadcast(this.snapshot());

        // Go directly to done (skip processing/validating for WebCodecs)
        this.setState('done', { force: true });
        return { ok: true, snapshot: this.snapshot() };
      }

      // Standard MediaRecorder path
      const result = await this.deps.offscreen.send<OffscreenResponse>({
        type: RuntimeMessageType.OFFSCREEN_STOP,
        sessionId: this.sessionId,
      });

      if (!result?.ok) {
        this.errorMessage = result?.error ?? 'Failed to stop recorder';
        this.setState('error');
        return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
      }

      return { ok: true, snapshot: this.snapshot() };
    } catch (error) {
      this.errorMessage = toErrorMessage(error);
      this.activeEncoderBackend = 'webcodecs';
      this.setState('error');
      return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
    }
  }

  async handleWebCodecsFatalError(errorMsg?: string) {
    if (!this.isUsingWebCodecsBackend() || !['recording', 'stopping', 'error'].includes(this.state)) {
      return { ok: true };
    }

    debugWarn('[Background] WebCodecs fatal error, triggering graceful stop:', errorMsg);
    try {
      const status = await this.deps.offscreen.send<{
        alive?: boolean;
        isWebCodecsRecording?: boolean;
      }>({
        type: RuntimeMessageType.OFFSCREEN_STATUS,
      });

      if (status?.alive && status.isWebCodecsRecording) {
        const result = await this.deps.offscreen.send<OffscreenResponse>({
          type: RuntimeMessageType.OFFSCREEN_STOP_WEBCODECS,
        });

        if (result?.ok) {
          this.outputUrl = result.outputUrl ?? null;
          this._outputFileName = this._outputFileName ?? buildDownloadFileName(this.sessionId, result.outputMimeType ?? 'video/mp4');
          this.validation = result.validation ?? null;
          this.processingProgress = 100;
          await this.deps.persist(this.toPersisted());
          await this.deps.broadcast(this.snapshot());
          this.setState('done', { force: true });
          return { ok: true, snapshot: this.snapshot() };
        }
      }
    } catch (error) {
      debugWarn('[Background] Graceful WebCodecs fatal stop failed:', error);
    }

    try {
      await this.deps.offscreen.send<{ ok?: boolean; error?: string }>({
        type: RuntimeMessageType.OFFSCREEN_FORCE_CLEANUP,
      });
    } catch (error) {
      debugWarn('[Background] Forced WebCodecs cleanup failed:', error);
    }

    this.recordingTabId = null;
    this.resetAttemptMetadata();
    this.errorMessage = errorMsg ?? 'WebCodecs recording failed unexpectedly';
    this.activeEncoderBackend = 'webcodecs';
    this.setState('error', { force: true });
    return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
  }

  async download() {
    if (!this.outputUrl) {
      return { ok: false, error: 'No processed MP4 is available yet', snapshot: this.snapshot() };
    }

    try {
      const filename = this._outputFileName ?? buildDownloadFileName(this.sessionId, 'video/mp4');
      const downloadId = await this.deps.download({
        url: this.outputUrl,
        filename,
        saveAs: true,
      });

      this.setState('idle');
      return { ok: true, downloadId, snapshot: this.snapshot() };
    } catch (error) {
      this.errorMessage = toErrorMessage(error);
      this.setState('error');
      return { ok: false, error: this.errorMessage, snapshot: this.snapshot() };
    }
  }

  async resetToIdle() {
    if (['recording', 'stopping', 'processing', 'validating', 'armed'].includes(this.state)) {
      return {
        ok: false,
        error: `Cannot reset while state is "${this.state}"`,
        snapshot: this.snapshot(),
      };
    }

    await this.releasePreflightMicHold();
    this.resetAttemptMetadata();
    this.setState('idle', { force: true });
    return { ok: true, snapshot: this.snapshot() };
  }

  async downloadRawChunks(targetSessionId: string) {
    if (!targetSessionId) {
      return { ok: false, error: 'Missing session id', snapshot: this.snapshot() };
    }

    try {
      await this.deps.offscreen.ensureReadyWithRetry(this.deps.delay);
      const result = await this.deps.offscreen.send<{
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
          snapshot: this.snapshot(),
        };
      }

      const items = Array.isArray(result.items) ? result.items : [];
      if (!items.length) {
        return {
          ok: false,
          error: 'No raw files available to download',
          snapshot: this.snapshot(),
        };
      }

      let downloadCount = 0;
      for (const item of items) {
        if (!item?.url || !item?.filename) continue;
        try {
          await this.deps.download({
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
          snapshot: this.snapshot(),
        };
      }

      return {
        ok: true,
        downloadCount,
        snapshot: this.snapshot(),
      };
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
        snapshot: this.snapshot(),
      };
    }
  }

  async applySystemAudioSignal(message: SystemAudioSignalMessage) {
    if (this.state !== 'recording') {
      return { ok: true };
    }

    if (message.type === RuntimeMessageType.SYSTEM_AUDIO_OK) {
      this.audioPreflight = {
        ...this.audioPreflight,
        systemAudioStatus: 'ok',
        systemAudioLevel: typeof message.level === 'number' ? message.level : null,
      };
      this.errorMessage = null;
      this.micWarningMessage = null;
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());
      return { ok: true };
    }

    const warningMessage = (() => {
      if (this.activeAudioSource === 'both') {
        return message.type === RuntimeMessageType.SYSTEM_AUDIO_ABSENT
          ? 'System audio track is missing. Recording continues with microphone.'
          : 'System audio appears silent. Recording continues with microphone.';
      }
      if (this.activeAudioSource === 'tab') {
        return message.type === RuntimeMessageType.SYSTEM_AUDIO_ABSENT
          ? 'System audio track is missing. The recording may not include tab audio.'
          : 'System audio appears silent. Check the tab output volume.';
      }
      return null;
    })();

    this.audioPreflight = {
      ...this.audioPreflight,
      systemAudioStatus: message.type === RuntimeMessageType.SYSTEM_AUDIO_ABSENT ? 'absent' : 'silent',
      systemAudioLevel: typeof message.level === 'number' ? message.level : null,
    };
    this.micWarningMessage = warningMessage;
    this.errorMessage = null;
    await this.deps.persist(this.toPersisted());
    await this.deps.broadcast(this.snapshot());
    return { ok: true };
  }

  async applyStorageSignal(message: StorageSignalMessage) {
    const availableMB =
      typeof message.availableMB === 'number' && Number.isFinite(message.availableMB)
        ? Math.max(0, message.availableMB)
        : null;

    if (message.type === RuntimeMessageType.LOW_STORAGE_WARNING) {
      this.storageWarningMessage =
        availableMB === null
          ? 'Low storage detected while recording.'
          : `Low storage warning: ${Math.round(availableMB)}MB remaining.`;
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());
      return { ok: true };
    }

    this.storageWarningMessage =
      availableMB === null
        ? 'Critical storage level reached. Stopping recording safely.'
        : `Critical storage level (${Math.round(availableMB)}MB). Stopping recording safely.`;
    this.errorMessage = this.storageWarningMessage;
    await this.deps.persist(this.toPersisted());
    await this.deps.broadcast(this.snapshot());

    if (this.state === 'recording') {
      return await this.stop();
    }

    return { ok: true, snapshot: this.snapshot() };
  }

  async refreshOrphans() {
    await this.refreshOrphanedSessions();
    return { ok: true, snapshot: this.snapshot() };
  }

  private primeRecoveredSessionContext(orphan: OrphanedSession) {
    this.sessionId = orphan.sessionId;
    this.recordingStartTime = null;
    this.chunkCount = orphan.chunkCount;
    this.processingProgress = null;
    this.errorMessage = null;
    this.micWarningMessage = null;
    this._outputFileName = null;
    this.outputUrl = null;
    this.validation = null;
    this.processingMetrics = null;
    this.recoverySessionId = null;
    this.recoveryChunks = [];
    this.audioPreflight = { ...DEFAULT_AUDIO_PREFLIGHT };
  }

  async recoverOrphan(targetSessionId: string, chunkIndexes?: number[]) {
    try {
      if (!targetSessionId) {
        return { ok: false, error: 'Missing session id', snapshot: this.snapshot() };
      }

      if (['preflight', 'armed', 'recording', 'stopping', 'processing'].includes(this.state)) {
        return {
          ok: false,
          error: `Cannot recover while state is "${this.state}"`,
          snapshot: this.snapshot(),
        };
      }

      const target = this.orphanedSessions.find((session) => session.sessionId === targetSessionId);
      if (!target) {
        await this.refreshOrphanedSessions();
      }

      let resolvedTarget = target ?? this.orphanedSessions.find((session) => session.sessionId === targetSessionId);
      if (!resolvedTarget) {
        const canUseActiveRecoverySession =
          this.state === 'recovery' &&
          (this.recoverySessionId === targetSessionId || this.sessionId === targetSessionId);

        if (canUseActiveRecoverySession) {
          resolvedTarget = {
            sessionId: targetSessionId,
            startTime: this.recordingStartTime ?? Date.now(),
            chunkCount: this.recoveryChunks.length > 0 ? this.recoveryChunks.length : this.chunkCount,
            totalSize: 0,
          };
        } else {
          return { ok: false, error: 'Orphaned session not found', snapshot: this.snapshot() };
        }
      }

      let selectedChunkIndexes = chunkIndexes;
      if (!Array.isArray(selectedChunkIndexes) || !selectedChunkIndexes.length) {
        await this.deps.offscreen.ensureReadyWithRetry(this.deps.delay);
        const inspect = await this.deps.offscreen.send<RecoveryInspectResponse>({
          type: RuntimeMessageType.OFFSCREEN_RECOVERY_INSPECT,
          sessionId: targetSessionId,
        });

        if (!inspect?.ok) {
          return {
            ok: false,
            error: inspect?.error ?? 'Failed to inspect orphaned session chunks',
            snapshot: this.snapshot(),
          };
        }

        this.recordingQuality = normalizeCaptureQuality(inspect.recordingQuality);
        this.resolvedPreset =
          inspect.recordingResolvedQuality == null
            ? null
            : normalizeResolvedCaptureQuality(inspect.recordingResolvedQuality);

        const inspectedChunks = Array.isArray(inspect.chunks) ? inspect.chunks : [];
        const suspectChunks = inspectedChunks.filter((chunk) => chunk.status !== 'ok');
        if (suspectChunks.length) {
          this.recoverySessionId = targetSessionId;
          this.recoveryChunks = inspectedChunks.map((chunk) => ({
            ...chunk,
            included: chunk.status !== 'missing' && chunk.status === 'ok',
          }));
          this.errorMessage = 'Suspect chunks detected. Select chunks to include before processing.';
          // Orphan recovery can be entered directly from the control plane while idle,
          // so force the UI into recovery even when the state machine has not been
          // pre-armed by a validating flow.
          this.setState('recovery', { force: true });
          return {
            ok: false,
            error: this.errorMessage,
            snapshot: this.snapshot(),
          };
        }

        selectedChunkIndexes = inspectedChunks
          .filter((chunk) => chunk.status !== 'missing')
          .map((chunk) => chunk.index);
      }

      const fallbackRecoveryChunks =
        this.recoverySessionId === resolvedTarget.sessionId && this.recoveryChunks.length
          ? this.recoveryChunks.map((chunk) => ({ ...chunk }))
          : [];

      this.primeRecoveredSessionContext(resolvedTarget);
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());

      await this.runProcessingPipeline({
        targetSessionId: resolvedTarget.sessionId,
        chunkIndexes: selectedChunkIndexes,
        fallbackRecoveryChunks,
      });

      if (this.state === 'done' && this.outputUrl) {
        const downloadResult = await this.download();
        await this.refreshOrphanedSessions();
        return {
          ok: Boolean(downloadResult?.ok),
          error: downloadResult?.ok ? undefined : (downloadResult?.error as string | undefined),
          snapshot: this.snapshot(),
        };
      }

      await this.refreshOrphanedSessions();
      if (this.state === 'error' || this.state === 'recovery') {
        return {
          ok: false,
          error: this.errorMessage ?? 'Failed to recover orphaned session',
          snapshot: this.snapshot(),
        };
      }

      return { ok: true, snapshot: this.snapshot() };
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
        snapshot: this.snapshot(),
      };
    }
  }

  async discardOrphan(targetSessionId: string) {
    if (!targetSessionId) {
      return { ok: false, error: 'Missing session id', snapshot: this.snapshot() };
    }

    try {
      await this.deps.offscreen.ensureReadyWithRetry(this.deps.delay);
      const result = await this.deps.offscreen.send<{ ok?: boolean; error?: string }>({
        type: RuntimeMessageType.OFFSCREEN_CLEAR_SESSION,
        sessionId: targetSessionId,
      });

      if (!result?.ok) {
        return {
          ok: false,
          error: result?.error ?? 'Failed to discard orphaned session',
          snapshot: this.snapshot(),
        };
      }

      this.orphanedSessions = this.orphanedSessions.filter((session) => session.sessionId !== targetSessionId);
      if (this.recoverySessionId === targetSessionId) {
        this.recoverySessionId = null;
        this.recoveryChunks = [];
      }
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());
      await this.refreshOrphanedSessions();
      return { ok: true, snapshot: this.snapshot() };
    } catch (error) {
      return { ok: false, error: toErrorMessage(error), snapshot: this.snapshot() };
    }
  }

  async applyOffscreenEvent(message: OffscreenEventMessage) {
    if (typeof message.chunkCount === 'number') {
      this.chunkCount = Math.max(this.chunkCount, message.chunkCount);
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());
    }

    if (message.event === OffscreenEventType.PROCESS_PROGRESS && typeof message.progress === 'number') {
      const nextProgress = Math.max(0, Math.min(100, Math.floor(message.progress)));
      const currentProgress = typeof this.processingProgress === 'number' ? this.processingProgress : 0;
      this.processingProgress = Math.max(currentProgress, nextProgress);
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());
      return { ok: true };
    }

    if (message.event === OffscreenEventType.PROCESS_METRICS && message.metrics) {
      this.processingMetrics = message.metrics;
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());
      return { ok: true };
    }

    if (message.event === OffscreenEventType.WEBCODECS_STATS && message.webCodecsStats) {
      this.webCodecsStats = message.webCodecsStats;
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());
      return { ok: true };
    }

    if (message.event === OffscreenEventType.ERROR) {
      this.errorMessage = message.error ?? 'Offscreen pipeline error';
      if (this.isUsingWebCodecsBackend() && ['recording', 'stopping'].includes(this.state)) {
        await this.deps.persist(this.toPersisted());
        await this.deps.broadcast(this.snapshot());
        return { ok: true };
      }
      this.setState('error');
      return { ok: true };
    }

    if (message.event === OffscreenEventType.FINAL_CHUNK_WRITTEN) {
      if (this.state === 'stopping' && !this.isUsingWebCodecsBackend()) {
        // Critical transition: stopping -> processing happens only after OPFS confirms final chunk write.
        // WebCodecs path handles stop->done directly in stop(), so skip processing here.
        await this.runProcessingPipeline();
      }
      return { ok: true };
    }

    return { ok: true };
  }

  async applyMicMixFailed(message: MicMixFailedMessage) {
    if (!['armed', 'recording', 'stopping'].includes(this.state)) {
      return { ok: true };
    }

    if (this.activeAudioSource === 'tab' || this.activeAudioSource === 'silent') {
      return { ok: true };
    }

    this.micWarningMessage =
      message.fallback === 'mic_only'
        ? 'Tab audio unavailable — continuing with microphone only.'
        : 'Microphone unavailable — continuing without mic audio.';
    this.audioPreflight = {
      ...this.audioPreflight,
      micOk: message.fallback === 'mic_only',
      micError: message.reason ?? RuntimeMessageType.MIC_MIX_FAILED,
    };
    await this.deps.persist(this.toPersisted());
    await this.deps.broadcast(this.snapshot());
    return { ok: true };
  }

  private async runProcessingPipeline(options?: {
    targetSessionId?: string;
    chunkIndexes?: number[];
    fallbackRecoveryChunks?: RecoveryChunkCheck[];
  }) {
    if (this.processingPipelineRunning) return;
    const targetSessionId = options?.targetSessionId ?? this.sessionId;
    if (!targetSessionId) {
      this.errorMessage = 'Missing session id for processing';
      this.setState('error');
      return;
    }

    this.sessionId = targetSessionId;

    this.processingPipelineRunning = true;
    try {
      this.processingProgress = 0;
      this.setState('processing');

      const processPayload: Record<string, unknown> = {
        type: RuntimeMessageType.OFFSCREEN_PROCESS,
        sessionId: targetSessionId,
      };
      if (Array.isArray(options?.chunkIndexes) && options.chunkIndexes.length) {
        processPayload.chunkIndexes = options.chunkIndexes;
      }

      const processResult = await this.deps.offscreen.send<OffscreenResponse>(processPayload);

      if (!processResult?.ok || !processResult.outputUrl) {
        this.errorMessage = processResult?.error ?? 'MP4 processing failed';
        this.setState('error');
        return;
      }

      this.outputUrl = processResult.outputUrl;
      this._outputFileName = this._outputFileName ?? buildDownloadFileName(targetSessionId, processResult.outputMimeType ?? 'video/mp4');
      this.processingProgress = 100;
      this.validation = processResult.validation ?? null;
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());

      this.setState('validating');

      const validationResult =
        this.validation ??
        (await this.deps.offscreen.send<ValidationResult>({
          type: RuntimeMessageType.OFFSCREEN_VALIDATE,
        }));

      this.validation = validationResult ?? null;
      await this.deps.persist(this.toPersisted());
      await this.deps.broadcast(this.snapshot());

      if (!validationResult?.passed) {
        this.recoverySessionId = targetSessionId;
        let inspectError: string | null = null;

        try {
          const inspect = await this.deps.offscreen.send<RecoveryInspectResponse>({
            type: RuntimeMessageType.OFFSCREEN_RECOVERY_INSPECT,
            sessionId: targetSessionId,
          });

          if (inspect?.ok && Array.isArray(inspect.chunks) && inspect.chunks.length > 0) {
            this.recoveryChunks = inspect.chunks.map((chunk) => ({
              ...chunk,
              included: chunk.status !== 'missing',
            }));
          } else {
            inspectError = inspect?.error ?? null;
            this.recoveryChunks = Array.isArray(options?.fallbackRecoveryChunks)
              ? options.fallbackRecoveryChunks.map((chunk) => ({ ...chunk }))
              : [];
          }
        } catch (error) {
          inspectError = toErrorMessage(error);
          this.recoveryChunks = Array.isArray(options?.fallbackRecoveryChunks)
            ? options.fallbackRecoveryChunks.map((chunk) => ({ ...chunk }))
            : [];
        }

        this.errorMessage = inspectError
          ? `Validation failed again (${inspectError}). Try fewer chunks or download raw files.`
          : 'Validation failed again. Try fewer chunks or download raw files.';

        this.setState('recovery');
        return;
      }

      this.errorMessage = null;
      this.recoverySessionId = null;
      this.recoveryChunks = [];
      this.setState('done');
    } catch (error) {
      this.errorMessage = toErrorMessage(error);
      this.setState('error');
    } finally {
      this.processingPipelineRunning = false;
    }
  }

  private async getStartTargetTab(options?: { validateCapturable?: boolean }) {
    const testActiveTab = await this.deps.getTestActiveTabFixture();
    if (testActiveTab) {
      if (options?.validateCapturable !== false && typeof testActiveTab.url === 'string' && testActiveTab.url.trim()) {
        const capturable = isTabUrlCapturable(testActiveTab.url);
        if (!capturable.ok) {
          throw new Error(formatCodedStartError(capturable.code, capturable.message, testActiveTab.url));
        }
      }

      return testActiveTab as chrome.tabs.Tab;
    }

    const activeTab = await this.deps.queryActiveTab();

    if (!activeTab?.id) {
      throw new Error(
        formatCodedStartError(
          'TAB_NOT_AVAILABLE',
          'No active tab is available to record. Focus a browser tab and try again.',
        ),
      );
    }

    if (options?.validateCapturable !== false && typeof activeTab.url === 'string' && activeTab.url.trim()) {
      const capturable = isTabUrlCapturable(activeTab.url);
      if (!capturable.ok) {
        throw new Error(formatCodedStartError(capturable.code, capturable.message, activeTab.url));
      }
    }
    return activeTab;
  }

  private async releaseStaleTabCapture(targetTabId: number): Promise<{ ok: boolean; detail?: string }> {
    const activeCapture = await this.deps.getCapturedTabInfo(targetTabId);
    if (!activeCapture) {
      return { ok: true };
    }

    debugWarn('[Background] Detected stale tab capture, attempting cleanup', activeCapture);

    try {
      await this.deps.offscreen.ensureReadyWithRetry(this.deps.delay);
      await this.deps.offscreen.send<{ ok?: boolean; error?: string }>({
        type: RuntimeMessageType.OFFSCREEN_FORCE_CLEANUP,
      });
    } catch (error) {
      debugWarn('[Background] Offscreen force cleanup failed:', error);
    }

    await this.deps.delay(250);
    if (!(await this.deps.getCapturedTabInfo(targetTabId))) {
      return { ok: true };
    }

    try {
      await this.deps.offscreen.forceResetDocument();
    } catch (error) {
      debugWarn('[Background] Offscreen document reset failed:', error);
    }

    await this.deps.delay(400);
    const remainingCapture = await this.deps.getCapturedTabInfo(targetTabId);
    if (!remainingCapture) {
      return { ok: true };
    }

    return {
      ok: false,
      detail: `Capture state is still "${remainingCapture.status}".`,
    };
  }

  async onRecordingTabUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) {
    if (this.recordingTabId === null || tabId !== this.recordingTabId) return;
    if (this.state !== 'recording') return;
    if (changeInfo.status !== 'complete') return;
    await this.deps.showRecordingBanner(tabId);
  }
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
