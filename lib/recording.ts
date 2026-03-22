import type { CaptureQuality, CaptureResolvedQuality } from './messages';

export type RecordingState =
  | 'idle'
  | 'preflight'
  | 'preflight_error'
  | 'armed'
  | 'recording'
  | 'audio_warning'
  | 'stopping'
  | 'processing'
  | 'validating'
  | 'done'
  | 'recovery'
  | 'error';

export interface ValidationChecks {
  size: boolean;
  header: boolean;
  duration: boolean;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationChecks;
}

export interface ProcessingMetrics {
  chunkCount: number;
  mode: 'single' | 'single_copy' | 'concat';
  encodeProfile: string;
  inputBytes: number;
  outputBytes: number;
  ffmpegAlreadyLoaded: boolean;
  ffmpegLoadMs: number;
  manifestReadMs: number;
  chunkReadMs: number;
  ffmpegWriteMs: number;
  execMs: number;
  outputReadMs: number;
  validateMs: number;
  totalMs: number;
}

export type SystemAudioStatus = 'idle' | 'pending' | 'ok' | 'absent' | 'silent';

export interface AudioPreflightSnapshot {
  micChecked: boolean;
  micOk: boolean;
  micLevel: number | null;
  micError: string | null;
  systemAudioStatus: SystemAudioStatus;
  systemAudioLevel: number | null;
  systemAudioMessage: string | null;
  needsSystemAudioDecision: boolean;
}

export interface OrphanedSession {
  sessionId: string;
  startTime: number;
  chunkCount: number;
  totalSize: number;
}

export type RecoveryChunkStatus = 'ok' | 'suspect' | 'missing';

export interface RecoveryChunkCheck {
  index: number;
  size: number;
  status: RecoveryChunkStatus;
  expectedChecksum: string | null;
  actualChecksum: string | null;
  included: boolean;
}

export interface RecordingSnapshot {
  state: RecordingState;
  sessionId: string | null;
  recordingStartTime: number | null;
  elapsedSeconds: number;
  chunkCount: number;
  processingProgress: number | null;
  errorMessage: string | null;
  micWarningMessage: string | null;
  storageWarningMessage: string | null;
  canDownload: boolean;
  outputFileName: string | null;
  requestedPreset: CaptureQuality;
  resolvedPreset: CaptureResolvedQuality | null;
  /** Backward-compatible alias of the selected preset. Prefer `requestedPreset`. */
  recordingQuality: CaptureQuality;
  validation: ValidationResult | null;
  processingMetrics: ProcessingMetrics | null;
  audioPreflight: AudioPreflightSnapshot;
  orphanedSessions: OrphanedSession[];
  recoverySessionId: string | null;
  recoveryChunks: RecoveryChunkCheck[];
  webCodecsStats?: {
    framesEncoded: number;
    bytesWritten: number;
    droppedFrames: number;
    hardwareAccelerated: boolean;
    memoryPressureTier?: number;
    videoBitrateBps?: number;
  } | null;
}

export function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
