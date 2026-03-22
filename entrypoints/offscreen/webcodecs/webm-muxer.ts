import { Muxer, ArrayBufferTarget, StreamTarget } from 'webm-muxer';
import { debugWarn } from '@/lib/runtime-log';

export interface WebMMuxerConfig {
  width: number;
  height: number;
  framerate: number;
  /** Matroska codec id, e.g. V_VP8 or V_VP9 */
  videoMatroskaCodec: string;
  /** When false, video-only WebM (no audio track). */
  includeAudio: boolean;
  audioSampleRate: number;
  audioChannels: number;
}

export interface WebMMuxerCallbacks {
  onData?: (data: Uint8Array, position: number) => void;
  onError: (error: Error) => void;
}

export class WebMMuxerWrapper {
  private muxer: Muxer<ArrayBufferTarget> | Muxer<StreamTarget>;
  private target: ArrayBufferTarget | StreamTarget;
  private callbacks: WebMMuxerCallbacks;
  private videoChunkCount = 0;
  private audioChunkCount = 0;
  private finalized = false;
  private useStreaming: boolean;

  constructor(config: WebMMuxerConfig, callbacks: WebMMuxerCallbacks, streaming = false) {
    this.callbacks = callbacks;
    this.useStreaming = streaming;

    if (streaming && callbacks.onData) {
      this.target = new StreamTarget({
        onData: callbacks.onData,
        chunked: true,
        chunkSize: 4 * 1024 * 1024,
      });
    } else {
      this.target = new ArrayBufferTarget();
    }

    this.muxer = new Muxer({
      target: this.target,
      video: {
        codec: config.videoMatroskaCodec,
        width: config.width,
        height: config.height,
        frameRate: config.framerate,
      },
      ...(config.includeAudio
        ? {
            audio: {
              codec: 'A_OPUS',
              numberOfChannels: config.audioChannels,
              sampleRate: config.audioSampleRate,
            },
          }
        : {}),
      firstTimestampBehavior: 'offset',
    });
  }

  addVideoChunk(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) {
    if (this.finalized) {
      debugWarn('[WebMMuxer] Attempted to add video chunk after finalization');
      return;
    }

    try {
      this.muxer.addVideoChunk(chunk, metadata);
      this.videoChunkCount++;
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  addAudioChunk(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) {
    if (this.finalized) {
      debugWarn('[WebMMuxer] Attempted to add audio chunk after finalization');
      return;
    }

    try {
      this.muxer.addAudioChunk(chunk, metadata);
      this.audioChunkCount++;
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

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
}
