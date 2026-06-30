/**
 * FFmpeg-backed processing + output validation, factored out of the offscreen
 * script. The aggregate (or script glue) constructs one Processor and delegates
 * OFFSCREEN_PROCESS / OFFSCREEN_VALIDATE to it.
 *
 * The Processor owns the FFmpeg runtime lifecycle and the "last output" store
 * (blob + object URL). Everything browser/Chrome-specific — OPFS reads, event
 * emission, object-URL creation, the HTMLVideoElement duration probe, and the
 * lazy FFmpeg import + worker URLs — is reached through the injected port so the
 * branch selection, metrics, and validation-fallback ordering are unit-testable.
 */
import type { ProcessingMetrics, ValidationResult } from '@/lib/recording';
import { OffscreenEventType, type OffscreenEventTypeValue } from '@/lib/messages';
import { debugInfo } from '@/lib/runtime-log';
import { buildDownloadFileName, toErrorMessage } from '../../background/utils';
import type { FFmpegClass, SessionManifest } from '../types';
import {
  hasMp4FtypHeader,
  hasWebmEbmlHeader,
  isMp4ArrayBuffer,
  probeMp4DurationFromMetadata,
} from '../media/container-probe';
import {
  buildConcatTranscodeArgs,
  buildSingleTranscodeArgs,
  getExpectedMinimumDurationSeconds,
  OUTPUT_VIDEO_CODEC,
  parseProgressFromLog,
} from './ffmpeg-args';
import type { OpfsBridge } from '../storage/opfs-bridge';

export interface ProcessorDeps {
  opfs: Pick<OpfsBridge, 'readManifest' | 'readChunk' | 'readWebCodecsStream'>;
  emit(event: OffscreenEventTypeValue, payload: Record<string, unknown>): Promise<void>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** Read media duration via HTMLVideoElement metadata (the only `document` user). */
  probeVideoDuration(blob: Blob): Promise<number>;
  /** Lazily import the FFmpeg constructor (dynamic `@ffmpeg/ffmpeg` import). */
  importFFmpegCtor(): Promise<FFmpegClass>;
  /** Resolved worker/core/wasm URLs for `ffmpeg.load()`. */
  ffmpegLoadConfig: { classWorkerURL: string; coreURL: string; wasmURL: string };
  isRecorderActive(): boolean;
  chunkDurationSeconds: number;
}

export class Processor {
  private FFmpegCtor: FFmpegClass | null = null;
  private ffmpeg: InstanceType<FFmpegClass> | null = null;
  private ffmpegLoaded = false;
  private ffmpegLoadCount = 0;
  private ffmpegLastLoadMs = 0;
  private ffmpegDurationHint = 0;
  private ffmpegLastProgress = -1;

  private lastOutputBlob: Blob | null = null;
  private lastOutputUrl: string | null = null;

  constructor(private readonly deps: ProcessorDeps) {}

  get outputBlob(): Blob | null {
    return this.lastOutputBlob;
  }

  get outputUrl(): string | null {
    return this.lastOutputUrl;
  }

  /** Store a finished output blob, revoking any previous URL; returns the new URL. */
  adoptOutput(blob: Blob): string {
    if (this.lastOutputUrl) {
      this.deps.revokeObjectURL(this.lastOutputUrl);
    }
    this.lastOutputBlob = blob;
    this.lastOutputUrl = this.deps.createObjectURL(blob);
    return this.lastOutputUrl;
  }

  private webCodecsOpfsStreamName(manifest: SessionManifest): string {
    return manifest.webCodecsOpfsStreamFile ?? 'webcodecs-stream.mp4';
  }

  async processRecording(sessionId: string, selectedChunkIndexes?: number[]) {
    const metrics: ProcessingMetrics = {
      chunkCount: 0,
      mode: 'concat',
      encodeProfile: OUTPUT_VIDEO_CODEC,
      inputBytes: 0,
      outputBytes: 0,
      ffmpegAlreadyLoaded: this.ffmpegLoaded,
      ffmpegLoadMs: 0,
      manifestReadMs: 0,
      chunkReadMs: 0,
      ffmpegWriteMs: 0,
      execMs: 0,
      outputReadMs: 0,
      validateMs: 0,
      totalMs: 0,
    };
    const processingStartedAt = performance.now();

    if (!sessionId) {
      return { ok: false, error: 'Missing session id' };
    }

    if (this.deps.isRecorderActive()) {
      return { ok: false, error: 'Cannot process while recorder is active' };
    }

    try {
      const manifestReadStart = performance.now();
      const currentManifest = await this.deps.opfs.readManifest(sessionId);
      metrics.manifestReadMs = performance.now() - manifestReadStart;

      if (currentManifest.recordingKind === 'webcodecs-opfs') {
        const readStart = performance.now();
        const streamFile = this.webCodecsOpfsStreamName(currentManifest);
        const outMime =
          (currentManifest.mimeType ?? '').includes('webm') ? 'video/webm' : 'video/mp4';
        const outExt = outMime.includes('webm') ? 'webm' : 'mp4';
        let streamData: ArrayBuffer;
        try {
          streamData = await this.deps.opfs.readWebCodecsStream(sessionId, streamFile);
        } catch {
          return { ok: false, error: 'No WebCodecs stream data found for this session' };
        }
        metrics.chunkReadMs += performance.now() - readStart;
        metrics.inputBytes = streamData.byteLength;
        metrics.chunkCount = 1;
        metrics.mode = 'single_copy';
        metrics.encodeProfile = outExt === 'webm' ? 'copy_webm' : 'copy_mp4';
        metrics.outputBytes = streamData.byteLength;

        const blob = new Blob([streamData], { type: outMime });
        const outputUrl = this.adoptOutput(blob);

        const validateStart = performance.now();
        const validation = await this.validateBlob(blob);
        metrics.validateMs = performance.now() - validateStart;
        metrics.totalMs = performance.now() - processingStartedAt;

        await this.deps.emit(OffscreenEventType.PROCESS_PROGRESS, { progress: 100 });
        await this.deps.emit(OffscreenEventType.PROCESS_METRICS, { metrics });
        debugInfo('[Offscreen] Processing metrics', metrics);

        return {
          ok: true,
          outputUrl,
          outputMimeType: outMime,
          fileName: buildDownloadFileName(currentManifest.exportBaseName ?? sessionId, outMime),
          validation,
        };
      }

      if (!currentManifest.chunks.length) {
        return { ok: false, error: 'No chunks found for this session' };
      }

      const orderedChunks = [...currentManifest.chunks].sort((a, b) => a.index - b.index);
      const selectedIndexSet =
        Array.isArray(selectedChunkIndexes) && selectedChunkIndexes.length
          ? new Set(selectedChunkIndexes)
          : null;
      const selectedChunks = selectedIndexSet
        ? orderedChunks.filter((chunk) => selectedIndexSet.has(chunk.index))
        : orderedChunks;

      if (!selectedChunks.length) {
        return { ok: false, error: 'No selected chunks found for processing' };
      }

      metrics.chunkCount = selectedChunks.length;
      metrics.mode = selectedChunks.length === 1 ? 'single' : 'concat';
      const captureMimeType = (currentManifest.mimeType ?? '').toLowerCase();
      const captureIsMp4 = captureMimeType.includes('mp4');
      let singleChunkData: ArrayBuffer | null = null;

      if (selectedChunks.length === 1) {
        const readStart = performance.now();
        singleChunkData = await this.deps.opfs.readChunk(sessionId, selectedChunks[0].index);
        metrics.chunkReadMs += performance.now() - readStart;
        metrics.inputBytes += singleChunkData.byteLength;

        const canFastCopy =
          currentManifest.mimeType?.includes('mp4') || isMp4ArrayBuffer(singleChunkData);

        if (canFastCopy) {
          metrics.mode = 'single_copy';
          metrics.encodeProfile = 'copy_mp4';
          metrics.outputBytes = singleChunkData.byteLength;

          const blob = new Blob([singleChunkData], { type: 'video/mp4' });
          const outputUrl = this.adoptOutput(blob);

          const validateStart = performance.now();
          const validation = await this.validateBlob(blob);
          metrics.validateMs = performance.now() - validateStart;
          metrics.totalMs = performance.now() - processingStartedAt;

          await this.deps.emit(OffscreenEventType.PROCESS_PROGRESS, { progress: 100 });
          await this.deps.emit(OffscreenEventType.PROCESS_METRICS, { metrics });
          debugInfo('[Offscreen] Processing metrics', metrics);

          return {
            ok: true,
            outputUrl,
            outputMimeType: 'video/mp4',
            fileName: buildDownloadFileName(currentManifest.exportBaseName ?? sessionId, 'video/mp4'),
            validation,
          };
        }
      }

      const ffmpegLoadStart = performance.now();
      const ff = await this.ensureFFmpeg();
      metrics.ffmpegLoadMs = performance.now() - ffmpegLoadStart;
      const fileNames: string[] = [];

      if (selectedChunks.length === 1) {
        const data = singleChunkData ?? (await this.deps.opfs.readChunk(sessionId, selectedChunks[0].index));
        if (!singleChunkData) {
          metrics.inputBytes += data.byteLength;
        }
        const writeStart = performance.now();
        const fileName = captureIsMp4 || isMp4ArrayBuffer(data) ? 'input.mp4' : 'input.webm';
        await ff.writeFile(fileName, new Uint8Array(data));
        metrics.ffmpegWriteMs += performance.now() - writeStart;
        fileNames.push(fileName);
      } else if (captureIsMp4) {
        for (const chunk of selectedChunks) {
          const readStart = performance.now();
          const data = await this.deps.opfs.readChunk(sessionId, chunk.index);
          metrics.chunkReadMs += performance.now() - readStart;
          metrics.inputBytes += data.byteLength;

          const writeStart = performance.now();
          const fileName = `chunk-${chunk.index}.mp4`;
          await ff.writeFile(fileName, new Uint8Array(data));
          metrics.ffmpegWriteMs += performance.now() - writeStart;
          fileNames.push(fileName);
        }

        const concatListWriteStart = performance.now();
        const concatList = fileNames.map((name) => `file '${name}'`).join('\n');
        await ff.writeFile('list.txt', new TextEncoder().encode(concatList));
        metrics.ffmpegWriteMs += performance.now() - concatListWriteStart;
      } else {
        // WebM chunks from MediaRecorder.ondataavailable are NOT standalone
        // files — only the first chunk contains the EBML/Tracks initialization
        // segment.  The concat demuxer requires each file to be independently
        // parseable, so feeding raw chunks produces a truncated output (only
        // chunk 0 is decoded).  Instead, concatenate all chunks into a single
        // binary blob which FFmpeg can demux as one continuous WebM stream.
        const chunkBuffers: Uint8Array[] = [];
        for (const chunk of selectedChunks) {
          const readStart = performance.now();
          const data = await this.deps.opfs.readChunk(sessionId, chunk.index);
          metrics.chunkReadMs += performance.now() - readStart;
          metrics.inputBytes += data.byteLength;
          chunkBuffers.push(new Uint8Array(data));
        }

        const totalLength = chunkBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const buf of chunkBuffers) {
          merged.set(buf, offset);
          offset += buf.byteLength;
        }

        const writeStart = performance.now();
        const fileName = 'input.webm';
        await ff.writeFile(fileName, merged);
        metrics.ffmpegWriteMs += performance.now() - writeStart;
        fileNames.push(fileName);
      }

      this.ffmpegDurationHint = selectedChunks.length * this.deps.chunkDurationSeconds;
      this.ffmpegLastProgress = 5;
      await this.deps.emit(OffscreenEventType.PROCESS_PROGRESS, { progress: 5 });

      const shouldRunConcatDemuxer = fileNames.length > 1;
      const transcodeArgs = shouldRunConcatDemuxer
        ? buildConcatTranscodeArgs()
        : buildSingleTranscodeArgs(fileNames[0]);

      const execStart = performance.now();
      metrics.encodeProfile = OUTPUT_VIDEO_CODEC;
      await ff.exec(transcodeArgs);
      metrics.execMs = performance.now() - execStart;

      const minimumDuration =
        selectedChunks.length > 1
          ? getExpectedMinimumDurationSeconds(selectedChunks.length, this.deps.chunkDurationSeconds)
          : 0;

      const readAndValidateOutput = async () => {
        const outputReadStart = performance.now();
        const outputData = await ff.readFile('output.mp4');
        const bytes =
          outputData instanceof Uint8Array ? new Uint8Array(outputData) : new Uint8Array(0);
        metrics.outputReadMs += performance.now() - outputReadStart;
        const blob = new Blob([bytes.buffer], { type: 'video/mp4' });

        const validateStart = performance.now();
        const outputValidation = await this.validateBlob(blob, minimumDuration);
        metrics.validateMs += performance.now() - validateStart;

        return { bytes, blob, validation: outputValidation };
      };

      const outputResult = await readAndValidateOutput();

      metrics.outputBytes = outputResult.bytes.byteLength;
      const outputUrl = this.adoptOutput(outputResult.blob);

      const validation = outputResult.validation;
      metrics.totalMs = performance.now() - processingStartedAt;

      await this.deps.emit(OffscreenEventType.PROCESS_PROGRESS, { progress: 100 });
      await this.deps.emit(OffscreenEventType.PROCESS_METRICS, { metrics });
      debugInfo('[Offscreen] Processing metrics', metrics);
      this.ffmpegDurationHint = 0;

      await this.cleanupFfmpegFiles(fileNames);

      return {
        ok: true,
        outputUrl,
        outputMimeType: 'video/mp4',
        fileName: buildDownloadFileName(currentManifest.exportBaseName ?? sessionId, 'video/mp4'),
        validation,
      };
    } catch (error) {
      metrics.totalMs = performance.now() - processingStartedAt;
      await this.deps.emit(OffscreenEventType.PROCESS_METRICS, { metrics });
      debugInfo('[Offscreen] Processing metrics (failed)', metrics);
      await this.deps.emit(OffscreenEventType.ERROR, {
        error: `Processing failed: ${toErrorMessage(error)}`,
      });
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  async validateLatestOutput(): Promise<ValidationResult> {
    if (!this.lastOutputBlob) {
      return {
        passed: false,
        checks: {
          size: false,
          header: false,
          duration: false,
        },
      };
    }

    return this.validateBlob(this.lastOutputBlob);
  }

  private async ensureFFmpeg() {
    if (!this.FFmpegCtor) {
      this.FFmpegCtor = await this.deps.importFFmpegCtor();
    }

    if (!this.ffmpeg) {
      this.ffmpeg = new this.FFmpegCtor();
      this.ffmpeg.on('log', ({ message }) => {
        const progress = parseProgressFromLog(message, this.ffmpegDurationHint);
        if (progress !== null && progress > this.ffmpegLastProgress) {
          this.ffmpegLastProgress = progress;
          void this.deps.emit(OffscreenEventType.PROCESS_PROGRESS, { progress });
        }
      });
    }

    if (!this.ffmpegLoaded) {
      const loadStart = performance.now();
      await this.ffmpeg.load(this.deps.ffmpegLoadConfig);
      this.ffmpegLoaded = true;
      this.ffmpegLoadCount += 1;
      this.ffmpegLastLoadMs = performance.now() - loadStart;
      debugInfo('[Offscreen] FFmpeg loaded on cold path', {
        ffmpegLoadCount: this.ffmpegLoadCount,
        ffmpegLastLoadMs: this.ffmpegLastLoadMs,
      });
    }

    return this.ffmpeg;
  }

  private async cleanupFfmpegFiles(fileNames: string[]) {
    if (!this.ffmpegLoaded || !this.ffmpeg) return;

    for (const fileName of fileNames) {
      await this.ffmpeg.deleteFile(fileName).catch(() => {});
    }

    await this.ffmpeg.deleteFile('list.txt').catch(() => {});
    await this.ffmpeg.deleteFile('output.mp4').catch(() => {});
  }

  private async validateBlob(blob: Blob, minimumDurationSeconds = 0): Promise<ValidationResult> {
    const isWebm = blob.type.includes('webm');
    const checks = {
      size: blob.size > 50_000,
      header: isWebm ? await hasWebmEbmlHeader(blob) : await hasMp4FtypHeader(blob),
      duration: await this.checkDurationWithFallback(blob, minimumDurationSeconds),
    };

    return {
      passed: Object.values(checks).every(Boolean),
      checks,
    };
  }

  private async probeDuration(blob: Blob): Promise<number> {
    const mediaDuration = await this.deps.probeVideoDuration(blob);

    if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
      return mediaDuration;
    }

    // Fallback: some MP4 outputs are not duration-probable via HTMLVideoElement in offscreen context.
    // Parse mvhd metadata directly to avoid false negatives in validation.
    const mp4Duration = await probeMp4DurationFromMetadata(blob);
    return Number.isFinite(mp4Duration) && mp4Duration > 0 ? mp4Duration : 0;
  }

  private async checkDurationWithFallback(
    blob: Blob,
    minimumDurationSeconds = 0,
  ): Promise<boolean> {
    if (minimumDurationSeconds <= 0 && blob.size > 1_000_000) return true;

    const isDurationValid = (value: number) =>
      Number.isFinite(value) &&
      value > 0 &&
      (minimumDurationSeconds <= 0 || value >= minimumDurationSeconds);

    const mediaDuration = await this.probeDuration(blob);
    if (isDurationValid(mediaDuration)) {
      return true;
    }

    const ffprobeDuration = await this.probeDurationViaFfprobe(blob);
    return isDurationValid(ffprobeDuration);
  }

  private async probeDurationViaFfprobe(blob: Blob): Promise<number> {
    let inputFile = '';
    let outputFile = '';

    try {
      const ff = await this.ensureFFmpeg();
      const nonce = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      inputFile = `probe-${nonce}.mp4`;
      outputFile = `probe-${nonce}.txt`;

      await ff.writeFile(inputFile, new Uint8Array(await blob.arrayBuffer()));
      const returnCode = await ff.ffprobe([
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputFile,
        '-o',
        outputFile,
      ]);

      if (returnCode !== 0) return 0;

      const output = await ff.readFile(outputFile, 'utf8');
      const text = typeof output === 'string' ? output : new TextDecoder().decode(output);
      const parsed = Number.parseFloat(text.trim());
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch {
      return 0;
    } finally {
      if (this.ffmpegLoaded && this.ffmpeg) {
        if (outputFile) await this.ffmpeg.deleteFile(outputFile).catch(() => {});
        if (inputFile) await this.ffmpeg.deleteFile(inputFile).catch(() => {});
      }
    }
  }
}
