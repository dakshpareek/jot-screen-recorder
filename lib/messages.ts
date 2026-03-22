import type { ProcessingMetrics, RecordingSnapshot, RecoveryChunkCheck, ValidationResult } from './recording';

export type AudioSource = 'both' | 'mic' | 'tab' | 'silent';
export type CaptureQuality = '720p' | '1080p';

export const RuntimeMessageType = {
  GET_STATE: 'GET_STATE',
  STATE_CHANGE: 'STATE_CHANGE',

  START: 'START',
  PREPARE_START: 'PREPARE_START',
  RUN_MIC_CHECK: 'RUN_MIC_CHECK',
  RELEASE_MIC_CHECK: 'RELEASE_MIC_CHECK',
  CANCEL_START: 'CANCEL_START',
  STOP: 'STOP',
  DOWNLOAD: 'DOWNLOAD',
  RESET_TO_IDLE: 'RESET_TO_IDLE',
  DOWNLOAD_RAW_CHUNKS: 'DOWNLOAD_RAW_CHUNKS',
  SYSTEM_AUDIO_CONTINUE: 'SYSTEM_AUDIO_CONTINUE',
  SYSTEM_AUDIO_STOP_RETRY: 'SYSTEM_AUDIO_STOP_RETRY',
  RECOVER_ORPHAN: 'RECOVER_ORPHAN',
  DISCARD_ORPHAN: 'DISCARD_ORPHAN',
  REFRESH_ORPHANS: 'REFRESH_ORPHANS',
  OPEN_MIC_SETTINGS: 'OPEN_MIC_SETTINGS',

  OFFSCREEN_START: 'OFFSCREEN_START',
  OFFSCREEN_STOP: 'OFFSCREEN_STOP',
  OFFSCREEN_PROCESS: 'OFFSCREEN_PROCESS',
  OFFSCREEN_VALIDATE: 'OFFSCREEN_VALIDATE',
  MIC_PREFLIGHT: 'MIC_PREFLIGHT',
  OFFSCREEN_RELEASE_PREFLIGHT_MIC: 'OFFSCREEN_RELEASE_PREFLIGHT_MIC',
  OFFSCREEN_PAUSE: 'OFFSCREEN_PAUSE',
  OFFSCREEN_RESUME: 'OFFSCREEN_RESUME',
  OFFSCREEN_SCAN_ORPHANS: 'OFFSCREEN_SCAN_ORPHANS',
  OFFSCREEN_CLEAR_SESSION: 'OFFSCREEN_CLEAR_SESSION',
  OFFSCREEN_RECOVERY_INSPECT: 'OFFSCREEN_RECOVERY_INSPECT',
  OFFSCREEN_STATUS: 'OFFSCREEN_STATUS',
  OFFSCREEN_DOWNLOAD_RAW_CHUNKS: 'OFFSCREEN_DOWNLOAD_RAW_CHUNKS',

  OFFSCREEN_READY: 'OFFSCREEN_READY',
  OFFSCREEN_EVENT: 'OFFSCREEN_EVENT',

  // Experimental WebCodecs pipeline
  WEBCODECS_CHECK_SUPPORT: 'WEBCODECS_CHECK_SUPPORT',
  OFFSCREEN_START_WEBCODECS: 'OFFSCREEN_START_WEBCODECS',
  OFFSCREEN_STOP_WEBCODECS: 'OFFSCREEN_STOP_WEBCODECS',
  WEBCODECS_FATAL_ERROR: 'WEBCODECS_FATAL_ERROR',
  GET_EXPERIMENTAL_FLAGS: 'GET_EXPERIMENTAL_FLAGS',
  SET_EXPERIMENTAL_FLAGS: 'SET_EXPERIMENTAL_FLAGS',

  SYSTEM_AUDIO_OK: 'SYSTEM_AUDIO_OK',
  SYSTEM_AUDIO_SILENT: 'SYSTEM_AUDIO_SILENT',
  SYSTEM_AUDIO_ABSENT: 'SYSTEM_AUDIO_ABSENT',
  LOW_STORAGE_WARNING: 'LOW_STORAGE_WARNING',
  AUTO_STOP_LOW_STORAGE: 'AUTO_STOP_LOW_STORAGE',
  MIC_MIX_FAILED: 'MIC_MIX_FAILED',

  RECORDING_BANNER: 'RECORDING_BANNER',
} as const;

export type RuntimeMessageTypeValue =
  (typeof RuntimeMessageType)[keyof typeof RuntimeMessageType];

export const OffscreenEventType = {
  CHUNK_WRITTEN: 'CHUNK_WRITTEN',
  FINAL_CHUNK_WRITTEN: 'FINAL_CHUNK_WRITTEN',
  PROCESS_PROGRESS: 'PROCESS_PROGRESS',
  PROCESS_METRICS: 'PROCESS_METRICS',
  ERROR: 'ERROR',
  WEBCODECS_STATS: 'WEBCODECS_STATS',
} as const;

export type OffscreenEventTypeValue = (typeof OffscreenEventType)[keyof typeof OffscreenEventType];

export type OffscreenEventMessage = {
  type: typeof RuntimeMessageType.OFFSCREEN_EVENT;
  event: OffscreenEventTypeValue;
  chunkCount?: number;
  progress?: number;
  error?: string;
  metrics?: ProcessingMetrics;
  webCodecsStats?: {
    framesEncoded: number;
    bytesWritten: number;
    droppedFrames: number;
    hardwareAccelerated: boolean;
    memoryPressureTier?: number;
    videoBitrateBps?: number;
  };
};

export type OffscreenResponse = {
  ok: boolean;
  error?: string;
  outputUrl?: string;
  fileName?: string;
  validation?: ValidationResult;
};

export type MicPreflightResponse = {
  ok: boolean;
  level?: number;
  deviceLabel?: string | null;
  error?: string;
};

export type RecoveryInspectResponse = {
  ok: boolean;
  error?: string;
  chunks?: RecoveryChunkCheck[];
  recordingQuality?: CaptureQuality;
};

export type StateChangeMessage = {
  type: typeof RuntimeMessageType.STATE_CHANGE;
  snapshot: RecordingSnapshot;
};

export type SystemAudioSignalMessage = {
  type:
    | typeof RuntimeMessageType.SYSTEM_AUDIO_OK
    | typeof RuntimeMessageType.SYSTEM_AUDIO_SILENT
    | typeof RuntimeMessageType.SYSTEM_AUDIO_ABSENT;
  level?: number;
  error?: string;
};

export type StorageSignalMessage = {
  type:
    | typeof RuntimeMessageType.LOW_STORAGE_WARNING
    | typeof RuntimeMessageType.AUTO_STOP_LOW_STORAGE;
  availableMB?: number;
};

export type MicMixFailedMessage = {
  type: typeof RuntimeMessageType.MIC_MIX_FAILED;
  reason?: string;
  fallback?: 'mic_only' | 'tab_only';
};

export type CommandResponse = {
  ok?: boolean;
  error?: string;
  snapshot?: RecordingSnapshot;
} | null;
