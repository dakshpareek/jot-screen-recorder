export type RecordingState =
  | 'idle'
  | 'preflight'
  | 'preflight_error'
  | 'armed'
  | 'recording'
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

export interface RecordingSnapshot {
  state: RecordingState;
  sessionId: string | null;
  recordingStartTime: number | null;
  elapsedSeconds: number;
  chunkCount: number;
  processingProgress: number | null;
  errorMessage: string | null;
  canDownload: boolean;
  outputFileName: string | null;
  validation: ValidationResult | null;
  processingMetrics: ProcessingMetrics | null;
}

export function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
