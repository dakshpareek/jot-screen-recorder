import type {
  AudioPreflightSnapshot,
  OrphanedSession,
  ProcessingMetrics,
  RecordingSnapshot,
  RecordingState,
  RecoveryChunkCheck,
  ValidationResult,
} from '@/lib/recording';
import type { CaptureQuality, CaptureResolvedQuality } from '@/lib/messages';
import { normalizeCaptureQuality, normalizeResolvedCaptureQuality } from '@/lib/capture-presets';

const CONTEXT_KEY = 'phase2-recording-context';
const EXPERIMENTAL_FLAGS_KEY = 'experimental-flags';

export interface PersistedContext {
  state: RecordingState;
  sessionId: string | null;
  recordingStartTime: number | null;
  chunkCount: number;
  processingProgress: number | null;
  errorMessage: string | null;
  micWarningMessage: string | null;
  storageWarningMessage: string | null;
  outputFileName: string | null;
  requestedPreset?: CaptureQuality;
  resolvedPreset?: CaptureResolvedQuality | null;
  recordingQuality?: CaptureQuality;
  usingWebCodecs?: boolean;
  validation: ValidationResult | null;
  processingMetrics: ProcessingMetrics | null;
  audioPreflight: AudioPreflightSnapshot;
  orphanedSessions: OrphanedSession[];
  recoverySessionId: string | null;
  recoveryChunks: RecoveryChunkCheck[];
  webCodecsStats?: RecordingSnapshot['webCodecsStats'];
}

export interface ExperimentalFlags {
  useWebCodecs: boolean;
}

const DEFAULT_EXPERIMENTAL_FLAGS: ExperimentalFlags = {
  useWebCodecs: false,
};

export async function loadPersistedContext(): Promise<PersistedContext | undefined> {
  const payload = (await chrome.storage.local.get(CONTEXT_KEY))[CONTEXT_KEY] as
    | PersistedContext
    | undefined;
  if (!payload) return payload;

  const migratedRequestedPreset = normalizeCaptureQuality(
    payload.requestedPreset ?? payload.recordingQuality,
  );
  const hasExplicitResolved = payload.resolvedPreset !== undefined && payload.resolvedPreset !== null;

  return {
    ...payload,
    requestedPreset: migratedRequestedPreset,
    resolvedPreset: hasExplicitResolved
      ? normalizeResolvedCaptureQuality(payload.resolvedPreset)
      : null,
    recordingQuality: migratedRequestedPreset,
  };
}

export async function savePersistedContext(payload: PersistedContext): Promise<void> {
  await chrome.storage.local.set({ [CONTEXT_KEY]: payload });
}

export async function loadExperimentalFlags(): Promise<ExperimentalFlags> {
  const stored = (await chrome.storage.local.get(EXPERIMENTAL_FLAGS_KEY))[EXPERIMENTAL_FLAGS_KEY] as
    | Partial<ExperimentalFlags>
    | undefined;
  return {
    ...DEFAULT_EXPERIMENTAL_FLAGS,
    ...(stored ?? {}),
  };
}

export async function saveExperimentalFlags(flags: Partial<ExperimentalFlags>): Promise<ExperimentalFlags> {
  const current = await loadExperimentalFlags();
  const updated = { ...current, ...flags };
  await chrome.storage.local.set({ [EXPERIMENTAL_FLAGS_KEY]: updated });
  return updated;
}
