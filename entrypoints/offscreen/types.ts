import type { OrphanedSession } from '@/lib/recording';
import type { CaptureQuality } from '@/lib/messages';

export interface ManifestChunk {
  index: number;
  size: number;
  written: boolean;
  duration: number;
  checksum: string;
}

export interface SessionManifest {
  sessionId: string;
  startTime: number;
  recordingQuality?: CaptureQuality;
  mimeType?: string;
  chunks: ManifestChunk[];
  totalDuration: number;
  status: 'recording' | 'stopping' | 'complete';
  /** When set, chunks[] may be empty; data lives in webcodecs-stream.mp4 (range writes). */
  recordingKind?: 'mediarecorder' | 'webcodecs-opfs';
  /** High-water byte length persisted for WebCodecs OPFS stream (crash recovery / orphans). */
  streamBytesWritten?: number;
  /** OPFS stream object name (e.g. webcodecs-stream.mp4 vs .webm). */
  webCodecsOpfsStreamFile?: string;
}

export interface WorkerResponse {
  type: string;
  chunkIndex?: number;
  data?: ArrayBuffer;
  found?: boolean;
  manifest?: SessionManifest;
  sessions?: OrphanedSession[];
  message?: string;
}

export interface RawDownloadItem {
  url: string;
  filename: string;
}

export type FFmpegClass = typeof import('@ffmpeg/ffmpeg').FFmpeg;
