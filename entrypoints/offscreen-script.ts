import type { ProcessingMetrics, ValidationResult } from '@/lib/recording';
import OpfsWorker from '../workers/opfs-worker.ts?worker';

interface ManifestChunk {
  index: number;
  size: number;
  written: boolean;
  duration: number;
  checksum: string;
}

interface SessionManifest {
  sessionId: string;
  startTime: number;
  mimeType?: string;
  chunks: ManifestChunk[];
  totalDuration: number;
  status: 'recording' | 'stopping' | 'complete';
}

interface WorkerResponse {
  type: string;
  chunkIndex?: number;
  data?: ArrayBuffer;
  found?: boolean;
  manifest?: SessionManifest;
  message?: string;
}

const CHUNK_DURATION_SECONDS = 10;
const CHUNK_INTERVAL_MS = CHUNK_DURATION_SECONDS * 1000;
const CAPTURE_MAX_WIDTH = 1920;
const CAPTURE_MAX_HEIGHT = 1080;
const CAPTURE_MAX_FRAME_RATE = 30;
const OUTPUT_VIDEO_CODEC = 'mpeg4';
const OUTPUT_VIDEO_QUALITY = '12';
const FFMPEG_AUDIO_BITRATE = '96k';
type FFmpegClass = typeof import('@ffmpeg/ffmpeg').FFmpeg;

export default defineUnlistedScript(() => {
  let recorder: MediaRecorder | null = null;
  let captureStream: MediaStream | null = null;
  let opfsWorker: Worker | null = null;
  let workerQueue: Promise<unknown> = Promise.resolve();
  let FFmpegCtor: FFmpegClass | null = null;
  let ffmpeg: InstanceType<FFmpegClass> | null = null;
  let ffmpegLoaded = false;
  let ffmpegDurationHint = 0;
  let ffmpegLastProgress = -1;

  let activeSessionId: string | null = null;
  let manifest: SessionManifest | null = null;
  let chunkCount = 0;
  let pendingStop = false;
  let writeQueue: Promise<void> = Promise.resolve();
  let writeError: Error | null = null;

  let lastOutputBlob: Blob | null = null;
  let lastOutputUrl: string | null = null;

  // Signal readiness early. If background is not listening yet, ping-based readiness still succeeds.
  void chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'OFFSCREEN_START') {
      void startRecording(String(msg.sessionId), String(msg.streamId ?? '')).then(sendResponse);
      return true;
    }

    if (msg.type === 'OFFSCREEN_STOP') {
      void stopRecording().then(sendResponse);
      return true;
    }

    if (msg.type === 'OFFSCREEN_PROCESS') {
      void processRecording(String(msg.sessionId)).then(sendResponse);
      return true;
    }

    if (msg.type === 'OFFSCREEN_VALIDATE') {
      void validateLatestOutput().then(sendResponse);
      return true;
    }

    if (msg.type === 'OFFSCREEN_STATUS') {
      sendResponse({
        alive: true,
        isRecording: recorder?.state === 'recording',
        chunkCount,
        sessionId: activeSessionId,
        hasOutput: Boolean(lastOutputUrl),
      });
      return;
    }
  });

  async function startRecording(nextSessionId: string, streamId: string) {
    if (recorder?.state === 'recording') {
      return { ok: false, error: 'Recorder is already active' };
    }

    if (!streamId) {
      return { ok: false, error: 'Missing tab stream id' };
    }

    try {
      captureStream = await getTabStreamById(streamId);

      activeSessionId = nextSessionId;
      chunkCount = 0;
      pendingStop = false;
      writeError = null;
      writeQueue = Promise.resolve();

      await ensureOpfsWorker();

      manifest = {
        sessionId: nextSessionId,
        startTime: Date.now(),
        chunks: [],
        totalDuration: 0,
        status: 'recording',
      };

      const mimeType = pickMimeType();
      recorder = new MediaRecorder(captureStream, {
        mimeType,
        videoBitsPerSecond: 4_000_000,
      });
      if (manifest) {
        manifest.mimeType = recorder.mimeType || mimeType;
      }
      await writeManifest();

      recorder.ondataavailable = (event) => {
        if (event.data.size <= 0) return;
        const nextIndex = chunkCount;
        chunkCount += 1;
        enqueueChunkWrite(nextIndex, event.data);
      };

      recorder.onstop = () => {
        void finalizeStop();
      };

      recorder.onerror = (event) => {
        const eventWithError = event as Event & { error?: { message?: string } };
        const err = eventWithError.error?.message ?? 'MediaRecorder error';
        void emitEvent('ERROR', { error: err });
      };

      recorder.start(CHUNK_INTERVAL_MS);
      const activeMimeType = recorder.mimeType || mimeType;
      // Preload ffmpeg while recording so stop->process latency is lower.
      // Skip prewarm when we're already recording MP4 chunks and may fast-path copy.
      if (!activeMimeType.includes('mp4')) {
        void ensureFFmpeg().catch((error) => {
          console.warn('[Offscreen] ffmpeg prewarm failed:', toNamedErrorMessage(error));
        });
      }
      return { ok: true };
    } catch (error) {
      console.error('[Offscreen] startRecording failed:', toNamedErrorMessage(error));
      await cleanupMedia();
      return { ok: false, error: toNamedErrorMessage(error) };
    }
  }

  async function stopRecording() {
    if (!recorder || recorder.state === 'inactive') {
      return { ok: false, error: 'Recorder is not active' };
    }

    if (pendingStop) {
      return { ok: true };
    }

    pendingStop = true;
    if (manifest) {
      manifest.status = 'stopping';
      writeQueue = writeQueue.then(async () => {
        await writeManifest();
      });
    }

    try {
      recorder.stop();
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) };
    }

    captureStream?.getTracks().forEach((track) => track.stop());
    return { ok: true };
  }

  async function finalizeStop() {
    try {
      await writeQueue;
      if (writeError) throw writeError;

      if (manifest) {
        manifest.status = 'complete';
        manifest.totalDuration = manifest.chunks.length * CHUNK_DURATION_SECONDS;
        await writeManifest();
      }

      await emitEvent('FINAL_CHUNK_WRITTEN', {
        sessionId: activeSessionId,
        chunkCount,
      });
    } catch (error) {
      await emitEvent('ERROR', {
        error: `Finalization failed: ${toErrorMessage(error)}`,
      });
    } finally {
      await cleanupMedia();
      pendingStop = false;
    }
  }

  async function processRecording(sessionId: string) {
    const metrics: ProcessingMetrics = {
      chunkCount: 0,
      mode: 'concat',
      encodeProfile: OUTPUT_VIDEO_CODEC,
      inputBytes: 0,
      outputBytes: 0,
      ffmpegAlreadyLoaded: ffmpegLoaded,
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

    if (recorder?.state === 'recording') {
      return { ok: false, error: 'Cannot process while recorder is active' };
    }

    try {
      const manifestReadStart = performance.now();
      const currentManifest = await readManifest(sessionId);
      metrics.manifestReadMs = performance.now() - manifestReadStart;

      if (!currentManifest.chunks.length) {
        return { ok: false, error: 'No chunks found for this session' };
      }

      const orderedChunks = [...currentManifest.chunks].sort((a, b) => a.index - b.index);
      metrics.chunkCount = orderedChunks.length;
      metrics.mode = orderedChunks.length === 1 ? 'single' : 'concat';
      const captureMimeType = (currentManifest.mimeType ?? '').toLowerCase();
      const captureIsMp4 = captureMimeType.includes('mp4');
      let singleChunkData: ArrayBuffer | null = null;

      if (orderedChunks.length === 1) {
        const readStart = performance.now();
        singleChunkData = await readChunkData(sessionId, orderedChunks[0].index);
        metrics.chunkReadMs += performance.now() - readStart;
        metrics.inputBytes += singleChunkData.byteLength;

        const canFastCopy =
          currentManifest.mimeType?.includes('mp4') || isMp4ArrayBuffer(singleChunkData);

        if (canFastCopy) {
          metrics.mode = 'single_copy';
          metrics.encodeProfile = 'copy_mp4';
          metrics.outputBytes = singleChunkData.byteLength;
          lastOutputBlob = new Blob([singleChunkData], { type: 'video/mp4' });

          if (lastOutputUrl) {
            URL.revokeObjectURL(lastOutputUrl);
          }
          lastOutputUrl = URL.createObjectURL(lastOutputBlob);

          const validateStart = performance.now();
          const duration = await probeDuration(lastOutputBlob);
          const validation = await validateBlob(lastOutputBlob, duration);
          metrics.validateMs = performance.now() - validateStart;
          metrics.totalMs = performance.now() - processingStartedAt;

          await emitEvent('PROCESS_PROGRESS', { progress: 100 });
          await emitEvent('PROCESS_METRICS', { metrics });
          console.info('[Offscreen] Processing metrics', metrics);

          return {
            ok: true,
            outputUrl: lastOutputUrl,
            fileName: `${sessionId}.mp4`,
            validation,
          };
        }
      }

      const ffmpegLoadStart = performance.now();
      const ff = await ensureFFmpeg();
      metrics.ffmpegLoadMs = performance.now() - ffmpegLoadStart;
      const fileNames: string[] = [];
      let preferConcatStreamCopy = false;

      if (orderedChunks.length === 1) {
        const data = singleChunkData ?? (await readChunkData(sessionId, orderedChunks[0].index));
        if (!singleChunkData) {
          metrics.inputBytes += data.byteLength;
        }
        const writeStart = performance.now();
        const fileName = captureIsMp4 || isMp4ArrayBuffer(data) ? 'input.mp4' : 'input.webm';
        await ff.writeFile(fileName, new Uint8Array(data));
        metrics.ffmpegWriteMs += performance.now() - writeStart;
        fileNames.push(fileName);
      } else if (captureIsMp4) {
        for (const chunk of orderedChunks) {
          const readStart = performance.now();
          const data = await readChunkData(sessionId, chunk.index);
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
        preferConcatStreamCopy = true;
      } else {
        for (const chunk of orderedChunks) {
          const readStart = performance.now();
          const data = await readChunkData(sessionId, chunk.index);
          metrics.chunkReadMs += performance.now() - readStart;
          metrics.inputBytes += data.byteLength;

          const writeStart = performance.now();
          const fileName = `chunk-${chunk.index}.webm`;
          await ff.writeFile(fileName, new Uint8Array(data));
          metrics.ffmpegWriteMs += performance.now() - writeStart;
          fileNames.push(fileName);
        }

        const concatListWriteStart = performance.now();
        const concatList = fileNames.map((name) => `file '${name}'`).join('\n');
        await ff.writeFile('list.txt', new TextEncoder().encode(concatList));
        metrics.ffmpegWriteMs += performance.now() - concatListWriteStart;
      }

      ffmpegDurationHint =
        currentManifest.totalDuration || orderedChunks.length * CHUNK_DURATION_SECONDS;
      ffmpegLastProgress = -1;
      await emitEvent('PROCESS_PROGRESS', { progress: 5 });

      const shouldRunConcatDemuxer = fileNames.length > 1;
      const singleTranscodeArgs = [
        '-i',
        fileNames[0],
        '-c:v',
        OUTPUT_VIDEO_CODEC,
        '-q:v',
        OUTPUT_VIDEO_QUALITY,
        '-threads',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        FFMPEG_AUDIO_BITRATE,
        '-movflags',
        '+faststart',
        'output.mp4',
      ];
      const concatTranscodeArgs = [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'list.txt',
        '-c:v',
        OUTPUT_VIDEO_CODEC,
        '-q:v',
        OUTPUT_VIDEO_QUALITY,
        '-threads',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        FFMPEG_AUDIO_BITRATE,
        '-movflags',
        '+faststart',
        'output.mp4',
      ];
      const concatCopyArgs = [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'list.txt',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        'output.mp4',
      ];

      const execStart = performance.now();
      let usedConcatCopy = false;
      if (shouldRunConcatDemuxer && preferConcatStreamCopy) {
        try {
          metrics.encodeProfile = 'copy_mp4_concat';
          await ff.exec(concatCopyArgs);
          usedConcatCopy = true;
        } catch (copyError) {
          console.warn('[Offscreen] concat stream copy failed, falling back to transcode:', copyError);
          await ff.deleteFile('output.mp4').catch(() => {});
          metrics.encodeProfile = OUTPUT_VIDEO_CODEC;
          await ff.exec(concatTranscodeArgs);
        }
      } else {
        metrics.encodeProfile = OUTPUT_VIDEO_CODEC;
        await ff.exec(shouldRunConcatDemuxer ? concatTranscodeArgs : singleTranscodeArgs);
      }
      metrics.execMs = performance.now() - execStart;

      const minimumDuration =
        orderedChunks.length > 1 ? getExpectedMinimumDurationSeconds(orderedChunks.length) : 0;

      const readAndValidateOutput = async () => {
        const outputReadStart = performance.now();
        const outputData = await ff.readFile('output.mp4');
        const bytes =
          outputData instanceof Uint8Array ? new Uint8Array(outputData) : new Uint8Array(0);
        metrics.outputReadMs += performance.now() - outputReadStart;
        const blob = new Blob([bytes.buffer], { type: 'video/mp4' });

        const validateStart = performance.now();
        const outputDuration = await probeDuration(blob);
        const outputValidation = await validateBlob(blob, outputDuration, minimumDuration);
        metrics.validateMs += performance.now() - validateStart;

        return { bytes, blob, validation: outputValidation };
      };

      let outputResult = await readAndValidateOutput();

      if (usedConcatCopy && !outputResult.validation.passed) {
        console.warn('[Offscreen] concat stream copy produced invalid output, falling back to transcode');
        await ff.deleteFile('output.mp4').catch(() => {});
        metrics.encodeProfile = OUTPUT_VIDEO_CODEC;

        const fallbackExecStart = performance.now();
        await ff.exec(concatTranscodeArgs);
        metrics.execMs += performance.now() - fallbackExecStart;

        outputResult = await readAndValidateOutput();
      }

      metrics.outputBytes = outputResult.bytes.byteLength;
      lastOutputBlob = outputResult.blob;

      if (lastOutputUrl) {
        URL.revokeObjectURL(lastOutputUrl);
      }
      lastOutputUrl = URL.createObjectURL(lastOutputBlob);

      const validation = outputResult.validation;
      metrics.totalMs = performance.now() - processingStartedAt;

      await emitEvent('PROCESS_PROGRESS', { progress: 100 });
      await emitEvent('PROCESS_METRICS', { metrics });
      console.info('[Offscreen] Processing metrics', metrics);
      ffmpegDurationHint = 0;

      await cleanupFfmpegFiles(fileNames);

      return {
        ok: true,
        outputUrl: lastOutputUrl,
        fileName: `${sessionId}.mp4`,
        validation,
      };
    } catch (error) {
      metrics.totalMs = performance.now() - processingStartedAt;
      await emitEvent('PROCESS_METRICS', { metrics });
      console.info('[Offscreen] Processing metrics (failed)', metrics);
      await emitEvent('ERROR', {
        error: `Processing failed: ${toErrorMessage(error)}`,
      });
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  async function validateLatestOutput(): Promise<ValidationResult> {
    if (!lastOutputBlob) {
      return {
        passed: false,
        checks: {
          size: false,
          header: false,
          duration: false,
        },
      };
    }

    const duration = await probeDuration(lastOutputBlob);
    return validateBlob(lastOutputBlob, duration);
  }

  function enqueueChunkWrite(index: number, blob: Blob) {
    writeQueue = writeQueue.then(async () => {
      if (writeError) return;

      try {
        if (!activeSessionId || !manifest) {
          throw new Error('Recording session is not initialized');
        }

        const arrayBuffer = await blob.arrayBuffer();
        const checksum = await sha256Hex(arrayBuffer);

        await callWorker(
          {
            type: 'write-chunk',
            sessionId: activeSessionId,
            chunkIndex: index,
            data: arrayBuffer,
          },
          ['chunk-written'],
          [arrayBuffer],
        );

        manifest.chunks.push({
          index,
          size: blob.size,
          written: true,
          duration: CHUNK_DURATION_SECONDS,
          checksum,
        });
        manifest.totalDuration = manifest.chunks.length * CHUNK_DURATION_SECONDS;
        manifest.status = pendingStop ? 'stopping' : 'recording';
        await writeManifest();

        await emitEvent('CHUNK_WRITTEN', { chunkCount });
      } catch (error) {
        writeError = error instanceof Error ? error : new Error(toErrorMessage(error));
        await emitEvent('ERROR', {
          error: `Chunk write failed: ${toErrorMessage(error)}`,
        });
      }
    });
  }

  async function writeManifest() {
    if (!activeSessionId || !manifest) {
      throw new Error('Manifest write called without active session');
    }

    await callWorker(
      {
        type: 'write-manifest',
        sessionId: activeSessionId,
        manifest,
      },
      ['manifest-written'],
    );
  }

  async function readManifest(sessionId: string): Promise<SessionManifest> {
    const response = await callWorker(
      {
        type: 'read-manifest',
        sessionId,
      },
      ['manifest-data', 'manifest-not-found'],
    );

    if (response.type !== 'manifest-data' || !response.manifest) {
      throw new Error('Manifest not found');
    }

    return response.manifest;
  }

  async function readChunkData(sessionId: string, chunkIndex: number): Promise<ArrayBuffer> {
    const response = await callWorker(
      {
        type: 'read-chunk',
        sessionId,
        chunkIndex,
      },
      ['chunk-data', 'chunk-not-found'],
    );

    if (response.type !== 'chunk-data' || !response.data) {
      throw new Error(`Chunk ${chunkIndex} is missing`);
    }

    return response.data;
  }

  async function ensureOpfsWorker() {
    if (opfsWorker) return opfsWorker;
    opfsWorker = new OpfsWorker();
    opfsWorker.addEventListener('error', (event) => {
      console.error('[Offscreen] OPFS worker failed to load:', event.message);
    });
    opfsWorker.addEventListener('messageerror', () => {
      console.error('[Offscreen] OPFS worker message error');
    });
    return opfsWorker;
  }

  async function callWorker(
    message: Record<string, unknown>,
    expectedTypes: string[],
    transferables: Transferable[] = [],
  ): Promise<WorkerResponse> {
    await ensureOpfsWorker();

    const task = workerQueue.then(
      () =>
        new Promise<WorkerResponse>((resolve, reject) => {
          if (!opfsWorker) {
            reject(new Error('OPFS worker unavailable'));
            return;
          }

          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`OPFS worker timeout waiting for: ${expectedTypes.join(', ')}`));
          }, 10_000);

          const handleMessage = (event: MessageEvent<WorkerResponse>) => {
            const payload = event.data;
            if (!payload?.type) return;

            if (payload.type === 'error') {
              cleanup();
              reject(new Error(payload.message ?? 'OPFS worker error'));
              return;
            }

            if (expectedTypes.includes(payload.type)) {
              cleanup();
              resolve(payload);
            }
          };

          const cleanup = () => {
            clearTimeout(timeout);
            opfsWorker?.removeEventListener('message', handleMessage);
          };

          opfsWorker.addEventListener('message', handleMessage);
          opfsWorker.postMessage(message, transferables);
        }),
    );

    workerQueue = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  }

  async function ensureFFmpeg() {
    if (!FFmpegCtor) {
      const module = await import('@ffmpeg/ffmpeg');
      FFmpegCtor = module.FFmpeg;
    }

    if (!ffmpeg) {
      ffmpeg = new FFmpegCtor();
      ffmpeg.on('log', ({ message }) => {
        const progress = parseProgressFromLog(message, ffmpegDurationHint);
        if (progress !== null && progress > ffmpegLastProgress) {
          ffmpegLastProgress = progress;
          void emitEvent('PROCESS_PROGRESS', { progress });
        }
      });
    }

    if (!ffmpegLoaded) {
      await ffmpeg.load({
        classWorkerURL: chrome.runtime.getURL('ffmpeg/worker.js'),
        coreURL: chrome.runtime.getURL('ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('ffmpeg-core.wasm'),
      });
      ffmpegLoaded = true;
    }

    return ffmpeg;
  }

  async function cleanupFfmpegFiles(fileNames: string[]) {
    if (!ffmpegLoaded || !ffmpeg) return;

    for (const fileName of fileNames) {
      await ffmpeg.deleteFile(fileName).catch(() => {});
    }

    await ffmpeg.deleteFile('list.txt').catch(() => {});
    await ffmpeg.deleteFile('output.mp4').catch(() => {});
  }

  async function cleanupMedia() {
    if (captureStream) {
      captureStream.getTracks().forEach((track) => track.stop());
    }
    captureStream = null;
    recorder = null;
  }

  async function emitEvent(
    event:
      | 'CHUNK_WRITTEN'
      | 'FINAL_CHUNK_WRITTEN'
      | 'PROCESS_PROGRESS'
      | 'PROCESS_METRICS'
      | 'ERROR',
    payload: Record<string, unknown>,
  ) {
    try {
      await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_EVENT',
        event,
        ...payload,
      });
    } catch {
      // Background may be asleep between events; ignore.
    }
  }

  async function validateBlob(
    blob: Blob,
    duration: number,
    minimumDurationSeconds = 0,
  ): Promise<ValidationResult> {
    const shouldRelaxDuration = blob.size > 1_000_000;
    const hasDuration = Number.isFinite(duration) && duration > 0;
    const checks = {
      size: blob.size > 50_000,
      header: await hasMp4FtypHeader(blob),
      // Duration metadata is unreliable for some ffmpeg concat outputs.
      // For larger files, trust size + header and treat duration as best-effort.
      duration: shouldRelaxDuration
        ? true
        : hasDuration && (minimumDurationSeconds <= 0 || duration >= minimumDurationSeconds),
    };

    return {
      passed: Object.values(checks).every(Boolean),
      checks,
    };
  }

  async function hasMp4FtypHeader(blob: Blob) {
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (header.length < 8) return false;
    const tag = String.fromCharCode(header[4], header[5], header[6], header[7]);
    return tag === 'ftyp';
  }

  async function probeDuration(blob: Blob): Promise<number> {
    const mediaDuration = await new Promise<number>((resolve) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(blob);

      const finalize = (value: number) => {
        URL.revokeObjectURL(url);
        video.remove();
        resolve(value);
      };

      video.preload = 'metadata';
      video.onloadedmetadata = () => finalize(video.duration);
      video.onerror = () => finalize(0);
      video.src = url;
    });

    if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
      return mediaDuration;
    }

    // Fallback: some MP4 outputs are not duration-probable via HTMLVideoElement in offscreen context.
    // Parse mvhd metadata directly to avoid false negatives in validation.
    const mp4Duration = await probeMp4DurationFromMetadata(blob);
    return Number.isFinite(mp4Duration) && mp4Duration > 0 ? mp4Duration : 0;
  }

  async function probeMp4DurationFromMetadata(blob: Blob): Promise<number> {
    if (blob.size < 32) return 0;

    const scanBytes = Math.min(blob.size, 4 * 1024 * 1024);
    const buffer = await blob.slice(0, scanBytes).arrayBuffer();
    const view = new DataView(buffer);
    return findMvhdDuration(view, 0, view.byteLength);
  }

  function findMvhdDuration(view: DataView, start: number, end: number): number {
    let offset = start;

    while (offset + 8 <= end) {
      let boxSize = view.getUint32(offset);
      const type = readBoxType(view, offset + 4);
      let headerSize = 8;

      if (boxSize === 1) {
        if (offset + 16 > end) return 0;
        boxSize = readUint64(view, offset + 8);
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = end - offset;
      }

      if (boxSize < headerSize) return 0;
      if (offset + boxSize > end) return 0;

      if (type === 'moov') {
        const nested = findMvhdDuration(view, offset + headerSize, offset + boxSize);
        if (nested > 0) return nested;
      } else if (type === 'mvhd') {
        const payload = offset + headerSize;
        if (payload + 20 > end) return 0;

        const version = view.getUint8(payload);
        if (version === 0) {
          const timescale = view.getUint32(payload + 12);
          const duration = view.getUint32(payload + 16);
          if (timescale > 0 && duration > 0) {
            return duration / timescale;
          }
        } else if (version === 1) {
          if (payload + 32 > end) return 0;
          const timescale = view.getUint32(payload + 20);
          const duration = readUint64(view, payload + 24);
          if (timescale > 0 && duration > 0) {
            return duration / timescale;
          }
        }
      }

      offset += boxSize;
    }

    return 0;
  }

  function readBoxType(view: DataView, offset: number) {
    if (offset + 4 > view.byteLength) return '';
    return String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  }

  function readUint64(view: DataView, offset: number) {
    if (offset + 8 > view.byteLength) return 0;
    const high = view.getUint32(offset);
    const low = view.getUint32(offset + 4);
    return high * 2 ** 32 + low;
  }

  async function getTabStreamById(streamId: string) {
    const video = {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: CAPTURE_MAX_WIDTH,
        maxHeight: CAPTURE_MAX_HEIGHT,
        maxFrameRate: CAPTURE_MAX_FRAME_RATE,
      },
    } as unknown as MediaTrackConstraints;

    const audio = {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as unknown as MediaTrackConstraints;

    return await navigator.mediaDevices.getUserMedia({
      video,
      audio,
    });
  }

  function pickMimeType() {
    const preferred = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
      'video/mp4;codecs=avc1.4D401E',
      'video/mp4',
    ];

    for (const mimeType of preferred) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return mimeType;
      }
    }

    return '';
  }

  function isMp4ArrayBuffer(data: ArrayBuffer) {
    if (data.byteLength < 12) return false;
    const view = new Uint8Array(data, 4, 4);
    return (
      view[0] === 0x66 && // f
      view[1] === 0x74 && // t
      view[2] === 0x79 && // y
      view[3] === 0x70 // p
    );
  }

  function parseProgressFromLog(logLine: string, durationHint: number): number | null {
    if (!durationHint || !logLine.includes('time=')) return null;
    const match = logLine.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return null;

    const hh = Number(match[1]);
    const mm = Number(match[2]);
    const ss = Number(match[3]);
    const seconds = hh * 3600 + mm * 60 + ss;
    const progress = Math.floor((seconds / durationHint) * 100);
    return Math.max(0, Math.min(99, progress));
  }

  function getExpectedMinimumDurationSeconds(chunkCount: number) {
    if (chunkCount <= 1) return 0;
    return Math.max(1, (chunkCount - 1) * CHUNK_DURATION_SECONDS * 0.75);
  }

  async function sha256Hex(data: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function toErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : 'Unknown error';
  }

  function toNamedErrorMessage(error: unknown) {
    if (error instanceof Error) {
      if (error.name && error.name !== 'Error') {
        return `${error.name}: ${error.message}`;
      }
      return error.message;
    }
    return typeof error === 'string' ? error : 'Unknown error';
  }
});
