import type { CaptureQuality, CaptureResolvedQuality } from '@/lib/messages';

// MediaStreamTrackProcessor is part of the Insertable Streams API (MediaCapture Transform)
// Not all TypeScript configurations include these types by default
declare global {
  interface MediaStreamTrackProcessor<T> {
    readonly readable: ReadableStream<T>;
  }

  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  var MediaStreamTrackProcessor: {
    prototype: MediaStreamTrackProcessor<VideoFrame | AudioData>;
    new <T extends VideoFrame | AudioData>(
      init: MediaStreamTrackProcessorInit
    ): MediaStreamTrackProcessor<T>;
  };
}

export interface WebCodecsEncoderConfig {
  codec: string;
  width: number;
  height: number;
  bitrate: number;
  minBitrateBps?: number;
  framerate: number;
  hardwareAcceleration: HardwareAcceleration;
  latencyMode: LatencyMode;
  keyframeIntervalFrames: number;
}

export interface WebCodecsAudioConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

// H.264 codec strings with high compatibility
// Format: avc1.XXYYZZ where XX=profile, YY=constraints, ZZ=level
// - 42 = Baseline profile
// - 4D = Main profile  
// - 64 = High profile
// - 00 = no constraints
// - Level: 1f=3.1, 20=3.2, 28=4.0, 29=4.1, 32=5.0, 33=5.1, 34=5.2
export const VIDEO_ENCODER_PROFILES: Record<CaptureResolvedQuality, WebCodecsEncoderConfig> = {
  auto: {
    codec: 'avc1.4d0028', // H.264 Main Profile Level 4.0 (1080p standard)
    width: 1920,
    height: 1080,
    bitrate: 4_000_000,
    minBitrateBps: 1_200_000,
    framerate: 30,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
    keyframeIntervalFrames: 150,
  },
  '1080p30': {
    codec: 'avc1.4d0028',
    width: 1920,
    height: 1080,
    bitrate: 4_000_000,
    minBitrateBps: 1_200_000,
    framerate: 30,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
    keyframeIntervalFrames: 150,
  },
  '1080p60': {
    codec: 'avc1.4d0032', // H.264 Main Profile Level 5.0 for 1080p60
    width: 1920,
    height: 1080,
    bitrate: 7_000_000,
    minBitrateBps: 1_800_000,
    framerate: 60,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
    keyframeIntervalFrames: 300, // keyframe every 5s at 60fps
  },
  '1440p30': {
    codec: 'avc1.640032', // H.264 High Profile Level 5.0 for 1440p
    width: 2560,
    height: 1440,
    bitrate: 9_000_000,
    minBitrateBps: 2_500_000,
    framerate: 30,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
    keyframeIntervalFrames: 150,
  },
  '4k30': {
    codec: 'avc1.640033', // H.264 High Profile Level 5.1 for 4K
    width: 3840,
    height: 2160,
    bitrate: 14_000_000,
    minBitrateBps: 4_000_000,
    framerate: 30,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
    keyframeIntervalFrames: 150,
  },
};

export const AUDIO_ENCODER_CONFIG: WebCodecsAudioConfig = {
  codec: 'mp4a.40.2', // AAC-LC
  sampleRate: 48000,
  numberOfChannels: 2,
  bitrate: 128_000,
};

/** Opus for WebM container (VP8/VP9 video path). */
export const OPUS_ENCODER_CONFIG: WebCodecsAudioConfig = {
  codec: 'opus',
  sampleRate: 48000,
  numberOfChannels: 2,
  bitrate: 128_000,
};

export interface EncoderCapabilityResult {
  videoSupported: boolean;
  audioSupported: boolean;
  hardwareAcceleration: boolean;
  fallbackReason: string | null;
  container: 'mp4' | 'webm';
  outputMimeType: string;
  opfsStreamFile: string;
  resolvedPreset: CaptureResolvedQuality;
}

export interface MuxerChunk {
  type: 'video' | 'audio';
  data: Uint8Array;
  timestamp: number;
  duration: number;
  isKeyframe: boolean;
}

export interface WebCodecsPipelineStats {
  framesEncoded: number;
  audioSamplesEncoded: number;
  bytesWritten: number;
  droppedFrames: number;
  averageEncodeTimeMs: number;
  hardwareAccelerated: boolean;
  /** 0 = normal; increases when the pipeline tightens limits or lowers bitrate under pressure. */
  memoryPressureTier: number;
  /** Current video encoder target bitrate after any adaptive backoff. */
  videoBitrateBps: number;
  container: 'mp4' | 'webm';
  outputMimeType: string;
  fileExtension: string;
}

/** Persist muxer output incrementally (e.g. OPFS range writes) to cap RAM during long recordings. */
export interface WebCodecsOpfsPersist {
  writeRange: (position: number, data: ArrayBuffer) => Promise<void>;
  readComplete: () => Promise<ArrayBuffer>;
}

export interface ResolvedWebCodecsFormat {
  videoSupported: boolean;
  audioSupported: boolean;
  hardwareAcceleration: boolean;
  fallbackReason: string | null;
  selectedVideoCodec: string | null;
  container: 'mp4' | 'webm';
  outputMimeType: string;
  opfsStreamFile: string;
  audioEncoderConfig: WebCodecsAudioConfig;
  resolvedPreset: CaptureResolvedQuality;
}

export interface WebCodecsPipelineOptions {
  requestedPreset: CaptureQuality;
  resolvedPreset: CaptureResolvedQuality;
  /** When set (e.g. from offscreen), must match manifest / OPFS stream file. */
  resolvedFormat?: ResolvedWebCodecsFormat;
  onProgress?: (stats: WebCodecsPipelineStats) => void;
  onError?: (error: Error) => void;
  onChunk?: (data: ArrayBuffer) => void;
  opfsPersist?: WebCodecsOpfsPersist;
}
