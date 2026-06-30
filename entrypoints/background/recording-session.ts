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
  TestPermissionState,
} from '@/lib/messages';
import { ALLOWED_TRANSITIONS } from './state/transitions';
import type {
  EncoderBackend,
  PersistedContext,
  RecorderSettings,
} from './state/persisted-context';
import type { OffscreenClient } from './services/offscreen-client';
import {
  normalizeCaptureQuality,
  normalizeResolvedCaptureQuality,
  normalizeSystemAudioStatus,
  toErrorMessage,
} from './utils';

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
}
