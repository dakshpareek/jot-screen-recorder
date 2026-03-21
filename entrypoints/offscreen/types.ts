import type { OrphanedSession } from '@/lib/recording';

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
  mimeType?: string;
  chunks: ManifestChunk[];
  totalDuration: number;
  status: 'recording' | 'stopping' | 'complete';
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
