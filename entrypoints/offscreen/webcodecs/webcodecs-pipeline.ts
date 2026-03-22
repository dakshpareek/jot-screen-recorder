import type { CaptureQuality } from '@/lib/messages';
import { debugWarn } from '@/lib/runtime-log';
import {
  VIDEO_ENCODER_PROFILES,
  type WebCodecsEncoderConfig,
  type WebCodecsPipelineStats,
  type WebCodecsPipelineOptions,
  type EncoderCapabilityResult,
  type ResolvedWebCodecsFormat,
} from './types';
import { resolveWebCodecsRecordingFormat, matroskaVideoCodecId } from './format-resolve';
import { MP4MuxerWrapper } from './mp4-muxer';
import { WebMMuxerWrapper } from './webm-muxer';
import type { RecordingMuxer } from './recording-muxer';

export class WebCodecsPipeline {
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private muxer: RecordingMuxer | null = null;
  private activeFormat: ResolvedWebCodecsFormat | null = null;

  private videoTrackProcessor: MediaStreamTrackProcessor<VideoFrame> | null = null;
  private audioTrackProcessor: MediaStreamTrackProcessor<AudioData> | null = null;

  private videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private audioReader: ReadableStreamDefaultReader<AudioData> | null = null;

  private quality: CaptureQuality;
  private options: WebCodecsPipelineOptions;

  private frameCount = 0;
  private audioSampleCount = 0;
  private droppedFrames = 0;
  private totalEncodeTimeMs = 0;
  private encodeCount = 0;
  private bytesWritten = 0;
  private hardwareAccelerated = false;

  private running = false;
  private stopping = false;
  private stopped = false;
  private fatalError: Error | null = null;

  private videoEncoderConfig: VideoEncoderConfig | null = null;
  private audioEncoderConfig: AudioEncoderConfig | null = null;

  private static readonly FLUSH_TIMEOUT_MS = 10_000;
  private static readonly BASE_MAX_VIDEO_QUEUE = 10;
  private static readonly BASE_MAX_AUDIO_QUEUE = 20;

  private memoryPressureTier = 0;
  private effectiveVideoQueueMax = WebCodecsPipeline.BASE_MAX_VIDEO_QUEUE;
  private effectiveAudioQueueMax = WebCodecsPipeline.BASE_MAX_AUDIO_QUEUE;
  private lastProgressDroppedFrames = 0;
  private zeroDropProgressWindows = 0;
  private currentVideoBitrate = 0;
  private minVideoBitrateBps = 900_000;
  private lastVideoBitrateBackoffAtFrame = Number.NEGATIVE_INFINITY;

  private pendingOpfsWrites: Promise<void> = Promise.resolve();
  private opfsFatalError: Error | null = null;

  constructor(options: WebCodecsPipelineOptions) {
    this.options = options;
    this.quality = options.quality;
  }

  static async checkCapabilities(quality: CaptureQuality): Promise<EncoderCapabilityResult> {
    const f = await resolveWebCodecsRecordingFormat(quality);
    return {
      videoSupported: f.videoSupported,
      audioSupported: f.audioSupported,
      hardwareAcceleration: f.hardwareAcceleration,
      fallbackReason: f.fallbackReason,
      container: f.container,
      outputMimeType: f.outputMimeType,
      opfsStreamFile: f.opfsStreamFile,
    };
  }

  async start(stream: MediaStream): Promise<void> {
    if (this.running) {
      throw new Error('Pipeline is already running');
    }

    this.pendingOpfsWrites = Promise.resolve();
    this.opfsFatalError = null;

    const profile = VIDEO_ENCODER_PROFILES[this.quality];

    const format =
      this.options.resolvedFormat ?? (await resolveWebCodecsRecordingFormat(this.quality));
    if (!format.videoSupported) {
      throw new Error(format.fallbackReason ?? 'Recording format not supported');
    }
    this.activeFormat = format;
    this.hardwareAccelerated = format.hardwareAcceleration;

    this.initializeMemoryPressureBaseline(profile);

    const hasAudio = stream.getAudioTracks().length > 0;
    const useOpfsStream = Boolean(this.options.opfsPersist);

    const muxerCallbacks = {
      onError: (error: Error) => {
        console.error('[WebCodecs] Muxer error:', error);
        this.options.onError?.(error);
      },
      onData:
        useOpfsStream && this.options.opfsPersist
          ? (data: Uint8Array, position: number) => {
              const copy = new Uint8Array(data.byteLength);
              copy.set(data);
              const pos = position;
              const persist = this.options.opfsPersist!;
              this.pendingOpfsWrites = this.pendingOpfsWrites
                .then(() => persist.writeRange(pos, copy.buffer))
                .catch((err: unknown) => {
                  const e = err instanceof Error ? err : new Error(String(err));
                  this.opfsFatalError ??= e;
                  this.options.onError?.(e);
                });
            }
          : undefined,
    };

    if (format.container === 'mp4') {
      this.muxer = new MP4MuxerWrapper(
        {
          width: profile.width,
          height: profile.height,
          framerate: profile.framerate,
          includeAudio: hasAudio,
          audioSampleRate: format.audioEncoderConfig.sampleRate,
          audioChannels: format.audioEncoderConfig.numberOfChannels,
        },
        muxerCallbacks,
        useOpfsStream,
      );
    } else {
      this.muxer = new WebMMuxerWrapper(
        {
          width: profile.width,
          height: profile.height,
          framerate: profile.framerate,
          videoMatroskaCodec: matroskaVideoCodecId(format.selectedVideoCodec!),
          includeAudio: hasAudio,
          audioSampleRate: format.audioEncoderConfig.sampleRate,
          audioChannels: format.audioEncoderConfig.numberOfChannels,
        },
        muxerCallbacks,
        useOpfsStream,
      );
    }

    // Set up video encoder
    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length > 0) {
      await this.initVideoEncoder(videoTracks[0], profile, format);
      // Handle stream ending unexpectedly (e.g. tab navigation, tab close)
      videoTracks[0].addEventListener('ended', () => this.handleTrackEnded('video'));
    }

    // Set up audio encoder
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
      await this.initAudioEncoder(audioTracks[0], format.audioEncoderConfig);
      audioTracks[0].addEventListener('ended', () => this.handleTrackEnded('audio'));
    }

    this.running = true;
    this.lastProgressDroppedFrames = this.droppedFrames;

    // Start processing loops
    if (this.videoReader) {
      void this.processVideoFrames();
    }
    if (this.audioReader) {
      void this.processAudioData();
    }
  }

  private initializeMemoryPressureBaseline(profile: WebCodecsEncoderConfig): void {
    this.currentVideoBitrate = profile.bitrate;
    this.minVideoBitrateBps = this.quality === '1080p' ? 1_200_000 : 900_000;
    const deviceMemory =
      typeof navigator !== 'undefined' && 'deviceMemory' in navigator
        ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
        : undefined;
    if (deviceMemory !== undefined && deviceMemory <= 4) {
      this.memoryPressureTier = Math.max(this.memoryPressureTier, 1);
    }
    this.recomputeQueueLimits();
  }

  private recomputeQueueLimits(): void {
    const t = this.memoryPressureTier;
    this.effectiveVideoQueueMax = Math.max(3, WebCodecsPipeline.BASE_MAX_VIDEO_QUEUE - t * 2);
    this.effectiveAudioQueueMax = Math.max(6, WebCodecsPipeline.BASE_MAX_AUDIO_QUEUE - t * 4);
  }

  private maybeAdaptToPressure(): void {
    const dropsDelta = this.droppedFrames - this.lastProgressDroppedFrames;
    this.lastProgressDroppedFrames = this.droppedFrames;

    if (dropsDelta >= 3) {
      this.zeroDropProgressWindows = 0;
      this.memoryPressureTier = Math.min(3, this.memoryPressureTier + 1);
      this.recomputeQueueLimits();
      this.tryReduceVideoBitrate();
      return;
    }

    if (dropsDelta === 0) {
      this.zeroDropProgressWindows++;
      if (this.zeroDropProgressWindows >= 12) {
        this.zeroDropProgressWindows = 0;
        if (this.memoryPressureTier > 0) {
          this.memoryPressureTier--;
          this.recomputeQueueLimits();
        }
      }
    } else {
      this.zeroDropProgressWindows = 0;
    }
  }

  private tryReduceVideoBitrate(): void {
    if (!this.videoEncoder || this.videoEncoder.state !== 'configured' || !this.videoEncoderConfig) {
      return;
    }
    if (this.frameCount - this.lastVideoBitrateBackoffAtFrame < 90) {
      return;
    }
    const next = Math.max(this.minVideoBitrateBps, Math.floor(this.currentVideoBitrate * 0.85));
    if (next >= this.currentVideoBitrate) {
      return;
    }
    try {
      const updated: VideoEncoderConfig = { ...this.videoEncoderConfig, bitrate: next };
      this.videoEncoder.configure(updated);
      this.videoEncoderConfig = updated;
      this.currentVideoBitrate = next;
      this.lastVideoBitrateBackoffAtFrame = this.frameCount;
    } catch {
      // Some platforms reject mid-recording reconfiguration; keep existing bitrate.
    }
  }

  private handleTrackEnded(kind: 'video' | 'audio'): void {
    if (this.stopping || !this.running) return;
    debugWarn(`[WebCodecs] ${kind} track ended unexpectedly`);
    // Video track ending is fatal — signal the error so the caller can stop gracefully
    if (kind === 'video') {
      this.fatalError = new Error('Video stream ended unexpectedly (tab may have been closed or navigated)');
      this.options.onError?.(this.fatalError);
    }
  }

  private async initVideoEncoder(
    track: MediaStreamTrack,
    profile: typeof VIDEO_ENCODER_PROFILES['1080p'],
    format: ResolvedWebCodecsFormat,
  ): Promise<void> {
    const selectedCodec = format.selectedVideoCodec;
    if (!selectedCodec) {
      throw new Error('No video codec in resolved format');
    }

    const useHardware = format.hardwareAcceleration;

    this.videoEncoderConfig = {
      codec: selectedCodec,
      width: profile.width,
      height: profile.height,
      bitrate: profile.bitrate,
      framerate: profile.framerate,
      hardwareAcceleration: useHardware ? 'prefer-hardware' : 'prefer-software',
      latencyMode: profile.latencyMode,
    };

    this.videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (this.muxer && !this.stopped) {
          this.muxer.addVideoChunk(chunk, metadata);
          this.bytesWritten += chunk.byteLength;
        }
      },
      error: (error) => {
        console.error('[WebCodecs] Video encoder error:', error);
        this.fatalError ??= error;
        this.options.onError?.(error);
      },
    });

    this.videoEncoder.configure(this.videoEncoderConfig);

    // Set up track processor to get VideoFrames
    this.videoTrackProcessor = new MediaStreamTrackProcessor({ track });
    this.videoReader = this.videoTrackProcessor.readable.getReader();
  }

  private async initAudioEncoder(
    track: MediaStreamTrack,
    config: ResolvedWebCodecsFormat['audioEncoderConfig'],
  ): Promise<void> {
    this.audioEncoderConfig = {
      codec: config.codec,
      sampleRate: config.sampleRate,
      numberOfChannels: config.numberOfChannels,
      bitrate: config.bitrate,
    };

    this.audioEncoder = new AudioEncoder({
      output: (chunk, metadata) => {
        if (this.muxer && !this.stopped) {
          this.muxer.addAudioChunk(chunk, metadata);
          this.bytesWritten += chunk.byteLength;
        }
      },
      error: (error) => {
        console.error('[WebCodecs] Audio encoder error:', error);
        this.fatalError ??= error;
        this.options.onError?.(error);
      },
    });

    this.audioEncoder.configure(this.audioEncoderConfig);

    // Set up track processor to get AudioData
    this.audioTrackProcessor = new MediaStreamTrackProcessor({ track });
    this.audioReader = this.audioTrackProcessor.readable.getReader();
  }

  private async processVideoFrames(): Promise<void> {
    if (!this.videoReader || !this.videoEncoder) return;

    const profile = VIDEO_ENCODER_PROFILES[this.quality];

    try {
      while (this.running && !this.stopping) {
        const { value: frame, done } = await this.videoReader.read();

        if (done) break;
        if (!frame) continue;

        try {
          // Drop frames if encoder is not ready or queue is backed up (memory pressure)
          if (
            this.videoEncoder.state !== 'configured' ||
            this.videoEncoder.encodeQueueSize > this.effectiveVideoQueueMax
          ) {
            this.droppedFrames++;
            continue;
          }

          const startTime = performance.now();
          const isKeyframe = this.frameCount % profile.keyframeIntervalFrames === 0;

          this.videoEncoder.encode(frame, { keyFrame: isKeyframe });
          this.frameCount++;

          this.totalEncodeTimeMs += performance.now() - startTime;
          this.encodeCount++;
        } finally {
          frame.close();
        }

        // Report progress periodically
        if (this.frameCount % 30 === 0) {
          this.reportProgress();
        }
      }
    } catch (error) {
      if (!this.stopping) {
        console.error('[WebCodecs] Video processing error:', error);
        this.options.onError?.(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }

  private async processAudioData(): Promise<void> {
    if (!this.audioReader || !this.audioEncoder) return;

    try {
      while (this.running && !this.stopping) {
        const { value: audioData, done } = await this.audioReader.read();

        if (done) break;
        if (!audioData) continue;

        try {
          if (
            this.audioEncoder.state !== 'configured' ||
            this.audioEncoder.encodeQueueSize > this.effectiveAudioQueueMax
          ) {
            continue;
          }

          this.audioEncoder.encode(audioData);
          this.audioSampleCount++;
        } finally {
          audioData.close();
        }
      }
    } catch (error) {
      if (!this.stopping) {
        console.error('[WebCodecs] Audio processing error:', error);
        this.options.onError?.(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }

  private reportProgress(): void {
    this.maybeAdaptToPressure();
    const stats = this.getStats();
    this.options.onProgress?.(stats);
  }

  async stop(): Promise<ArrayBuffer> {
    if (this.stopped) {
      throw new Error('Pipeline is already stopped');
    }

    this.stopping = true;
    this.running = false;

    // Cancel readers to stop the processing loops
    await this.videoReader?.cancel().catch(() => {});
    await this.audioReader?.cancel().catch(() => {});

    // Flush encoders with timeout to avoid hanging forever
    await this.flushEncoderWithTimeout(this.videoEncoder, 'video');
    await this.flushEncoderWithTimeout(this.audioEncoder, 'audio');

    // Close encoders
    this.closeEncoder(this.videoEncoder, 'video');
    this.closeEncoder(this.audioEncoder, 'audio');

    // Finalize muxer and get output
    if (!this.muxer) {
      throw new Error('Muxer not initialized');
    }

    // Drain muxer writes that were scheduled while encoding.
    await this.pendingOpfsWrites;
    if (this.opfsFatalError) {
      throw this.opfsFatalError;
    }

    const muxerOutput = this.muxer.finalize();
    let output: ArrayBuffer;
    if (muxerOutput) {
      output = muxerOutput;
    } else if (this.options.opfsPersist) {
      // finalize() flushes StreamTarget and schedules more range writes; read before they finish yields a missing file.
      await this.pendingOpfsWrites;
      if (this.opfsFatalError) {
        throw this.opfsFatalError;
      }
      output = await this.options.opfsPersist.readComplete();
    } else {
      throw new Error('Muxer produced no buffer and OPFS read was not configured');
    }
    this.stopped = true;

    // Release references to allow GC
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.videoReader = null;
    this.audioReader = null;
    this.videoTrackProcessor = null;
    this.audioTrackProcessor = null;
    this.muxer = null;

    return output;
  }

  private async flushEncoderWithTimeout(
    encoder: VideoEncoder | AudioEncoder | null,
    kind: string,
  ): Promise<void> {
    if (!encoder || encoder.state !== 'configured') return;

    try {
      await Promise.race([
        encoder.flush(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${kind} encoder flush timed out after ${WebCodecsPipeline.FLUSH_TIMEOUT_MS}ms`)),
            WebCodecsPipeline.FLUSH_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (error) {
      debugWarn(`[WebCodecs] ${kind} encoder flush failed:`, error);
    }
  }

  private closeEncoder(encoder: VideoEncoder | AudioEncoder | null, kind: string): void {
    if (!encoder || encoder.state === 'closed') return;
    try {
      encoder.close();
    } catch (error) {
      debugWarn(`[WebCodecs] ${kind} encoder close failed:`, error);
    }
  }

  getStats(): WebCodecsPipelineStats {
    const fmt = this.activeFormat;
    const container = fmt?.container ?? 'mp4';
    return {
      framesEncoded: this.frameCount,
      audioSamplesEncoded: this.audioSampleCount,
      bytesWritten: this.bytesWritten,
      droppedFrames: this.droppedFrames,
      averageEncodeTimeMs: this.encodeCount > 0
        ? this.totalEncodeTimeMs / this.encodeCount
        : 0,
      hardwareAccelerated: this.hardwareAccelerated,
      memoryPressureTier: this.memoryPressureTier,
      videoBitrateBps: this.currentVideoBitrate || VIDEO_ENCODER_PROFILES[this.quality].bitrate,
      container,
      outputMimeType: fmt?.outputMimeType ?? 'video/mp4',
      fileExtension: container === 'webm' ? 'webm' : 'mp4',
    };
  }

  isRunning(): boolean {
    return this.running && !this.stopping;
  }
}
