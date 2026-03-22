import type {
  AudioPreflightSnapshot,
  OrphanedSession,
  ProcessingMetrics,
  RecordingState,
  RecoveryChunkCheck,
  ValidationResult,
} from '@/lib/recording';
import type { CaptureQuality } from '@/lib/messages';

const CONTEXT_KEY = 'phase2-recording-context';

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
  recordingQuality?: CaptureQuality;
  validation: ValidationResult | null;
  processingMetrics: ProcessingMetrics | null;
  audioPreflight: AudioPreflightSnapshot;
  orphanedSessions: OrphanedSession[];
  recoverySessionId: string | null;
  recoveryChunks: RecoveryChunkCheck[];
}

export async function loadPersistedContext(): Promise<PersistedContext | undefined> {
  return (await chrome.storage.local.get(CONTEXT_KEY))[CONTEXT_KEY] as PersistedContext | undefined;
}

export async function savePersistedContext(payload: PersistedContext): Promise<void> {
  await chrome.storage.local.set({ [CONTEXT_KEY]: payload });
}
