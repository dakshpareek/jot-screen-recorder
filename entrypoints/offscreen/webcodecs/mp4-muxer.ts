import { Muxer, ArrayBufferTarget, StreamTarget } from 'mp4-muxer';
import { debugWarn } from '@/lib/runtime-log';

export interface MP4MuxerConfig {
  width: number;
  height: number;
  framerate: number;
  /** When false, fMP4 video-only (no AAC track). */
  includeAudio: boolean;
  audioSampleRate: number;
  audioChannels: number;
}

export interface MP4MuxerCallbacks {
  onData?: (data: Uint8Array, position: number) => void;
  onError: (error: Error) => void;
}

export class MP4MuxerWrapper {
  private muxer: Muxer<ArrayBufferTarget> | Muxer<StreamTarget>;
  private target: ArrayBufferTarget | StreamTarget;
  private config: MP4MuxerConfig;
  private callbacks: MP4MuxerCallbacks;
  private videoChunkCount = 0;
  private audioChunkCount = 0;
  private finalized = false;
  private useStreaming: boolean;

  constructor(config: MP4MuxerConfig, callbacks: MP4MuxerCallbacks, streaming = false) {
    this.config = config;
    this.callbacks = callbacks;
    this.useStreaming = streaming;

    if (streaming && callbacks.onData) {
      this.target = new StreamTarget({
        onData: callbacks.onData,
        chunked: true,
        chunkSize: 4 * 1024 * 1024, // 4MB chunks for OPFS writes
      });
    } else {
      this.target = new ArrayBufferTarget();
    }

    // Fragmented fMP4: sample payloads are written incrementally (see mp4-muxer docs).
    // Avoids the large peak RAM of fastStart: 'in-memory', which retains all chunks until finalize.
    this.muxer = new Muxer({
      target: this.target,
      video: {
        codec: 'avc',
        width: config.width,
        height: config.height,
        frameRate: config.framerate,
      },
      ...(config.includeAudio
        ? {
            audio: {
              codec: 'aac',
              numberOfChannels: config.audioChannels,
              sampleRate: config.audioSampleRate,
            },
          }
        : {}),
      fastStart: 'fragmented',
      minFragmentDuration: 2,
      firstTimestampBehavior: 'offset',
    });
  }

  addVideoChunk(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) {
    if (this.finalized) {
      debugWarn('[MP4Muxer] Attempted to add video chunk after finalization');
      return;
    }

    try {
      this.muxer.addVideoChunk(chunk, metadata);
      this.videoChunkCount++;
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  addAudioChunk(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) {
    if (this.finalized) {
      debugWarn('[MP4Muxer] Attempted to add audio chunk after finalization');
      return;
    }

    try {
      this.muxer.addAudioChunk(chunk, metadata);
      this.audioChunkCount++;
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Completes muxing. Returns the file bytes for in-memory targets; `null` when using
   * StreamTarget (caller loads final file from OPFS or another sink).
   */
  finalize(): ArrayBuffer | null {
    if (this.finalized) {
      throw new Error('Muxer already finalized');
    }

    this.finalized = true;
    this.muxer.finalize();

    if (this.target instanceof ArrayBufferTarget) {
      return this.target.buffer;
    }

    return null;
  }

  getStats() {
    return {
      videoChunks: this.videoChunkCount,
      audioChunks: this.audioChunkCount,
      finalized: this.finalized,
    };
  }

  isFinalized() {
    return this.finalized;
  }
}
