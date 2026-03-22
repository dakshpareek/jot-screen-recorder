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

/**
 * Global emergency rollback switch.
 * Set true to force MediaRecorder path regardless of saved/user flags.
 */
export const WEBCODECS_KILL_SWITCH_FORCE_LEGACY = false;

const DEFAULT_EXPERIMENTAL_FLAGS: ExperimentalFlags = {
  // 4.1: WebCodecs default-on for new users (unless explicitly disabled).
  useWebCodecs: true,
};

function applyExperimentalFlagPolicy(flags: ExperimentalFlags): ExperimentalFlags {
  if (WEBCODECS_KILL_SWITCH_FORCE_LEGACY) {
    return { ...flags, useWebCodecs: false };
  }
  return flags;
}

async function loadStoredExperimentalFlags(): Promise<Partial<ExperimentalFlags>> {
  const stored = (await chrome.storage.local.get(EXPERIMENTAL_FLAGS_KEY))[EXPERIMENTAL_FLAGS_KEY] as
    | Partial<ExperimentalFlags>
    | undefined;
  return stored ?? {};
}

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
  const stored = await loadStoredExperimentalFlags();
  const merged = {
    ...DEFAULT_EXPERIMENTAL_FLAGS,
    ...stored,
  };
  return applyExperimentalFlagPolicy(merged);
}

export async function saveExperimentalFlags(flags: Partial<ExperimentalFlags>): Promise<ExperimentalFlags> {
  const stored = await loadStoredExperimentalFlags();
  const currentRaw = {
    ...DEFAULT_EXPERIMENTAL_FLAGS,
    ...stored,
  };
  const updated = { ...currentRaw, ...flags };
  await chrome.storage.local.set({ [EXPERIMENTAL_FLAGS_KEY]: updated });
  return applyExperimentalFlagPolicy(updated);
}
