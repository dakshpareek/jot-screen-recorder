import type {
  AudioPreflightSnapshot,
  OrphanedSession,
  ProcessingMetrics,
  RecordingSnapshot,
  RecordingState,
  RecoveryChunkCheck,
  ValidationResult,
} from '@/lib/recording';
import type { CaptureQuality, CaptureResolvedQuality, EncoderBackend } from '@/lib/messages';
import { normalizeCaptureQuality, normalizeResolvedCaptureQuality } from '@/lib/capture-presets';
export type { EncoderBackend } from '@/lib/messages';

const CONTEXT_KEY = 'phase2-recording-context';
const RECORDER_SETTINGS_KEY = 'recorder-settings';
const LEGACY_EXPERIMENTAL_FLAGS_KEY = 'experimental-flags';

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

export interface RecorderSettings {
  encoderBackend: EncoderBackend;
}

interface LegacyExperimentalFlags {
  useWebCodecs?: boolean;
}

/**
 * Global emergency rollback switch.
 * Set true to force MediaRecorder path regardless of saved/user flags.
 */
export const WEBCODECS_KILL_SWITCH_FORCE_LEGACY = false;

const DEFAULT_RECORDER_SETTINGS: RecorderSettings = {
  // 4.1/4.3: WebCodecs default-on as the primary encoder backend.
  encoderBackend: 'webcodecs',
};

function normalizeEncoderBackend(value: unknown): EncoderBackend {
  if (value === 'mediarecorder') return 'mediarecorder';
  return 'webcodecs';
}

function applyRecorderSettingsPolicy(settings: RecorderSettings): RecorderSettings {
  if (WEBCODECS_KILL_SWITCH_FORCE_LEGACY) {
    return { ...settings, encoderBackend: 'mediarecorder' };
  }
  return settings;
}

async function loadStoredRecorderSettings(): Promise<Partial<RecorderSettings>> {
  const stored = await chrome.storage.local.get([RECORDER_SETTINGS_KEY, LEGACY_EXPERIMENTAL_FLAGS_KEY]);
  const current = stored[RECORDER_SETTINGS_KEY] as Partial<RecorderSettings> | undefined;
  if (current?.encoderBackend) {
    return {
      encoderBackend: normalizeEncoderBackend(current.encoderBackend),
    };
  }

  const legacy = stored[LEGACY_EXPERIMENTAL_FLAGS_KEY] as LegacyExperimentalFlags | undefined;
  if (typeof legacy?.useWebCodecs === 'boolean') {
    return {
      encoderBackend: legacy.useWebCodecs ? 'webcodecs' : 'mediarecorder',
    };
  }
  return {};
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

export async function loadRecorderSettings(): Promise<RecorderSettings> {
  const stored = await loadStoredRecorderSettings();
  const merged = {
    ...DEFAULT_RECORDER_SETTINGS,
    ...stored,
  };
  return applyRecorderSettingsPolicy({
    ...merged,
    encoderBackend: normalizeEncoderBackend(merged.encoderBackend),
  });
}

export async function saveRecorderSettings(
  settings: Partial<RecorderSettings>,
): Promise<RecorderSettings> {
  const stored = await loadStoredRecorderSettings();
  const currentRaw = {
    ...DEFAULT_RECORDER_SETTINGS,
    ...stored,
  };
  const updated = {
    ...currentRaw,
    ...settings,
    encoderBackend: normalizeEncoderBackend(settings.encoderBackend ?? currentRaw.encoderBackend),
  };
  await chrome.storage.local.set({ [RECORDER_SETTINGS_KEY]: updated });
  await chrome.storage.local.remove(LEGACY_EXPERIMENTAL_FLAGS_KEY).catch(() => {});
  return applyRecorderSettingsPolicy(updated);
}
