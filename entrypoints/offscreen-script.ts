import type {
  RecoveryChunkCheck,
  RecoveryChunkStatus,
  ProcessingMetrics,
  ValidationResult,
} from '@/lib/recording';
import {
  OffscreenEventType,
  RuntimeMessageType,
  type AudioSource,
  type OffscreenEventTypeValue,
} from '@/lib/messages';
import { OpfsBridge } from './offscreen/storage/opfs-bridge';
import type { FFmpegClass, RawDownloadItem, SessionManifest } from './offscreen/types';

const CHUNK_DURATION_SECONDS = 10;
const CHUNK_INTERVAL_MS = CHUNK_DURATION_SECONDS * 1000;
const PREFLIGHT_MIC_HOLD_MS = 60_000;
const CAPTURE_MAX_WIDTH = 1920;
const CAPTURE_MAX_HEIGHT = 1080;
const CAPTURE_MAX_FRAME_RATE = 30;
const OUTPUT_VIDEO_CODEC = 'libx264';
const OUTPUT_VIDEO_PRESET = 'fast';
const OUTPUT_VIDEO_CRF = '22';
const OUTPUT_FRAME_RATE = String(CAPTURE_MAX_FRAME_RATE);
const FFMPEG_AUDIO_BITRATE = '128k';

export default defineUnlistedScript(() => {
  const opfsBridge = new OpfsBridge();

  let recorder: MediaRecorder | null = null;
  let captureStream: MediaStream | null = null;
  let tabCaptureStream: MediaStream | null = null;
  let micCaptureStream: MediaStream | null = null;
  let preflightMicStream: MediaStream | null = null;
  let preflightMicHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let FFmpegCtor: FFmpegClass | null = null;
  let ffmpeg: InstanceType<FFmpegClass> | null = null;
  let ffmpegLoaded = false;
  let ffmpegDurationHint = 0;
  let ffmpegLastProgress = -1;

  let activeSessionId: string | null = null;
  let manifest: SessionManifest | null = null;
  let chunkCount = 0;
  let pendingStop = false;
  let stopFinalDataPromise: Promise<void> | null = null;
  let resolveStopFinalData: (() => void) | null = null;
  let stopFinalDataTimeout: ReturnType<typeof setTimeout> | null = null;
  let stopCompletionPromise: Promise<void> | null = null;
  let resolveStopCompletion: (() => void) | null = null;
  let writeQueue: Promise<void> = Promise.resolve();
  let writeError: Error | null = null;

  let lastOutputBlob: Blob | null = null;
  let lastOutputUrl: string | null = null;
  let systemAudioCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let systemAudioAudioCtx: AudioContext | null = null;
  let systemAudioSource: MediaStreamAudioSourceNode | null = null;
  let mixAudioCtx: AudioContext | null = null;
  let mixTabSource: MediaStreamAudioSourceNode | null = null;
  let mixMicSource: MediaStreamAudioSourceNode | null = null;
  let mixTabGain: GainNode | null = null;
  let mixMicGain: GainNode | null = null;
  let mixDestination: MediaStreamAudioDestinationNode | null = null;
  let storageMonitorInterval: ReturnType<typeof setInterval> | null = null;
  let rawExportRevokeTimer: ReturnType<typeof setTimeout> | null = null;
  const rawExportUrls = new Set<string>();

  // Signal readiness early. If background is not listening yet, ping-based readiness still succeeds.
  void chrome.runtime.sendMessage({ type: RuntimeMessageType.OFFSCREEN_READY }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === RuntimeMessageType.OFFSCREEN_START) {
      void startRecording(
        String(msg.sessionId),
        String(msg.streamId ?? ''),
        normalizeAudioSource(msg.audioSource),
        normalizeMicDeviceId(msg.micDeviceId),
      ).then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_STOP) {
      void stopRecording().then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_PROCESS) {
      const chunkIndexes = Array.isArray(msg.chunkIndexes)
        ? msg.chunkIndexes
            .map((value: unknown) => Number(value))
            .filter((value: number) => Number.isInteger(value) && value >= 0)
        : undefined;
      void processRecording(String(msg.sessionId), chunkIndexes).then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_VALIDATE) {
      void validateLatestOutput().then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.MIC_PREFLIGHT) {
      void runMicPreflight(normalizeMicDeviceId(msg.micDeviceId)).then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_RELEASE_PREFLIGHT_MIC) {
      releasePreflightMicStream();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_PAUSE) {
      void pauseRecording().then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_RESUME) {
      void resumeRecording().then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_SCAN_ORPHANS) {
      void scanOrphanedSessions().then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_CLEAR_SESSION) {
      void clearSessionData(String(msg.sessionId ?? '')).then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_RECOVERY_INSPECT) {
      void inspectRecoveryChunks(String(msg.sessionId ?? '')).then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_DOWNLOAD_RAW_CHUNKS) {
      void downloadRawChunks(String(msg.sessionId ?? '')).then(sendResponse);
      return true;
    }

    if (msg.type === RuntimeMessageType.OFFSCREEN_STATUS) {
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

  function normalizeAudioSource(value: unknown): AudioSource {
    if (value === 'mic' || value === 'tab' || value === 'silent') {
      return value;
    }
    return 'both';
  }

  function normalizeMicDeviceId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'default') return null;
    return trimmed;
  }

  async function startRecording(
    nextSessionId: string,
    streamId: string,
    audioSource: AudioSource,
    micDeviceId: string | null,
  ) {
    if (recorder?.state === 'recording') {
      return { ok: false, error: 'Recorder is already active' };
    }

    if (!streamId) {
      return { ok: false, error: 'Missing tab stream id' };
    }

    try {
      tabCaptureStream = await getTabStreamById(streamId);
      captureStream = await buildCaptureStream(tabCaptureStream, audioSource, micDeviceId);

      activeSessionId = nextSessionId;
      chunkCount = 0;
      pendingStop = false;
      writeError = null;
      writeQueue = Promise.resolve();

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

        // Final stop flush barrier: resolve only after chunk is queued for persistence.
        if (pendingStop) {
          resolveFinalStopData();
        }
      };

      recorder.onstop = () => {
        void finalizeStop();
      };

      recorder.onerror = (event) => {
        const eventWithError = event as Event & { error?: { message?: string } };
        const err = eventWithError.error?.message ?? 'MediaRecorder error';
        void emitEvent(OffscreenEventType.ERROR, { error: err });
      };

      recorder.start(CHUNK_INTERVAL_MS);
      // System-audio verification must inspect tab audio only (not mixed mic+tab output).
      startSystemAudioCheck(tabCaptureStream);
      startStorageMonitor();
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
      if (stopCompletionPromise) {
        await stopCompletionPromise;
      }
      return { ok: true };
    }

    pendingStop = true;
    stopFinalDataPromise = new Promise<void>((resolve) => {
      resolveStopFinalData = resolve;
    });
    stopFinalDataTimeout = setTimeout(() => {
      resolveFinalStopData();
    }, 1_500);
    stopCompletionPromise = new Promise<void>((resolve) => {
      resolveStopCompletion = resolve;
    });
    stopSystemAudioCheck();
    stopStorageMonitor();
    if (manifest) {
      manifest.status = 'stopping';
      writeQueue = writeQueue.then(async () => {
        await writeManifest();
      });
    }

    try {
      recorder.stop();
    } catch (error) {
      resolveStopCompletion?.();
      resolveStopCompletion = null;
      stopCompletionPromise = null;
      return { ok: false, error: toErrorMessage(error) };
    }

    await stopCompletionPromise;
    return { ok: true };
  }

  async function pauseRecording() {
    if (!recorder || recorder.state !== 'recording') {
      return { ok: false, error: 'Recorder is not actively recording' };
    }
    try {
      recorder.pause();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  async function resumeRecording() {
    if (!recorder || recorder.state !== 'paused') {
      return { ok: false, error: 'Recorder is not paused' };
    }
    try {
      recorder.resume();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  async function finalizeStop() {
    try {
      if (stopFinalDataPromise) {
        await stopFinalDataPromise;
      }
      await writeQueue;
      if (writeError) throw writeError;

      if (manifest) {
        manifest.status = 'complete';
        manifest.totalDuration = manifest.chunks.length * CHUNK_DURATION_SECONDS;
        await writeManifest();
      }

      await emitEvent(OffscreenEventType.FINAL_CHUNK_WRITTEN, {
        sessionId: activeSessionId,
        chunkCount,
      });
    } catch (error) {
      await emitEvent(OffscreenEventType.ERROR, {
        error: `Finalization failed: ${toErrorMessage(error)}`,
      });
    } finally {
      await cleanupMedia();
      clearFinalStopDataWait();
      pendingStop = false;
      resolveStopCompletion?.();
      resolveStopCompletion = null;
      stopCompletionPromise = null;
    }
  }

  function resolveFinalStopData() {
    if (!resolveStopFinalData) return;
    resolveStopFinalData();
    resolveStopFinalData = null;
    clearFinalStopDataTimeout();
  }

  function clearFinalStopDataTimeout() {
    if (!stopFinalDataTimeout) return;
    clearTimeout(stopFinalDataTimeout);
    stopFinalDataTimeout = null;
  }

  function clearFinalStopDataWait() {
    clearFinalStopDataTimeout();
    resolveStopFinalData = null;
    stopFinalDataPromise = null;
  }

  async function processRecording(sessionId: string, selectedChunkIndexes?: number[]) {
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
        singleChunkData = await readChunkData(sessionId, selectedChunks[0].index);
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
          const validation = await validateBlob(lastOutputBlob);
          metrics.validateMs = performance.now() - validateStart;
          metrics.totalMs = performance.now() - processingStartedAt;

          await emitEvent(OffscreenEventType.PROCESS_PROGRESS, { progress: 100 });
          await emitEvent(OffscreenEventType.PROCESS_METRICS, { metrics });
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

      if (selectedChunks.length === 1) {
        const data = singleChunkData ?? (await readChunkData(sessionId, selectedChunks[0].index));
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
          const data = await readChunkData(sessionId, chunk.index);
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

      ffmpegDurationHint =
        selectedChunks.length * CHUNK_DURATION_SECONDS;
      ffmpegLastProgress = 5;
      await emitEvent(OffscreenEventType.PROCESS_PROGRESS, { progress: 5 });

      const shouldRunConcatDemuxer = fileNames.length > 1;
      const singleTranscodeArgs = [
        '-i',
        fileNames[0],
        '-vsync',
        'cfr',
        '-r',
        OUTPUT_FRAME_RATE,
        '-c:v',
        OUTPUT_VIDEO_CODEC,
        '-preset',
        OUTPUT_VIDEO_PRESET,
        '-crf',
        OUTPUT_VIDEO_CRF,
        '-c:a',
        'aac',
        '-b:a',
        FFMPEG_AUDIO_BITRATE,
        '-movflags',
        '+faststart',
        '-pix_fmt',
        'yuv420p',
        'output.mp4',
      ];
      const concatTranscodeArgs = [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'list.txt',
        '-vsync',
        'cfr',
        '-r',
        OUTPUT_FRAME_RATE,
        '-c:v',
        OUTPUT_VIDEO_CODEC,
        '-preset',
        OUTPUT_VIDEO_PRESET,
        '-crf',
        OUTPUT_VIDEO_CRF,
        '-c:a',
        'aac',
        '-b:a',
        FFMPEG_AUDIO_BITRATE,
        '-movflags',
        '+faststart',
        '-pix_fmt',
        'yuv420p',
        'output.mp4',
      ];

      const execStart = performance.now();
      metrics.encodeProfile = OUTPUT_VIDEO_CODEC;
      await ff.exec(shouldRunConcatDemuxer ? concatTranscodeArgs : singleTranscodeArgs);
      metrics.execMs = performance.now() - execStart;

      const minimumDuration =
        selectedChunks.length > 1 ? getExpectedMinimumDurationSeconds(selectedChunks.length) : 0;

      const readAndValidateOutput = async () => {
        const outputReadStart = performance.now();
        const outputData = await ff.readFile('output.mp4');
        const bytes =
          outputData instanceof Uint8Array ? new Uint8Array(outputData) : new Uint8Array(0);
        metrics.outputReadMs += performance.now() - outputReadStart;
        const blob = new Blob([bytes.buffer], { type: 'video/mp4' });

        const validateStart = performance.now();
        const outputValidation = await validateBlob(blob, minimumDuration);
        metrics.validateMs += performance.now() - validateStart;

        return { bytes, blob, validation: outputValidation };
      };

      let outputResult = await readAndValidateOutput();

      metrics.outputBytes = outputResult.bytes.byteLength;
      lastOutputBlob = outputResult.blob;

      if (lastOutputUrl) {
        URL.revokeObjectURL(lastOutputUrl);
      }
      lastOutputUrl = URL.createObjectURL(lastOutputBlob);

      const validation = outputResult.validation;
      metrics.totalMs = performance.now() - processingStartedAt;

      await emitEvent(OffscreenEventType.PROCESS_PROGRESS, { progress: 100 });
      await emitEvent(OffscreenEventType.PROCESS_METRICS, { metrics });
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
      await emitEvent(OffscreenEventType.PROCESS_METRICS, { metrics });
      console.info('[Offscreen] Processing metrics (failed)', metrics);
      await emitEvent(OffscreenEventType.ERROR, {
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

    return validateBlob(lastOutputBlob);
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

        await opfsBridge.writeChunk(activeSessionId, index, arrayBuffer);

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

        await emitEvent(OffscreenEventType.CHUNK_WRITTEN, { chunkCount });
      } catch (error) {
        writeError = error instanceof Error ? error : new Error(toErrorMessage(error));
        await emitEvent(OffscreenEventType.ERROR, {
          error: `Chunk write failed: ${toErrorMessage(error)}`,
        });
      }
    });
  }

  async function writeManifest() {
    if (!activeSessionId || !manifest) {
      throw new Error('Manifest write called without active session');
    }

    await opfsBridge.writeManifest(activeSessionId, manifest);
  }

  async function readManifest(sessionId: string): Promise<SessionManifest> {
    return await opfsBridge.readManifest(sessionId);
  }

  async function readChunkData(sessionId: string, chunkIndex: number): Promise<ArrayBuffer> {
    return await opfsBridge.readChunk(sessionId, chunkIndex);
  }

  async function scanOrphanedSessions() {
    return {
      ok: true,
      sessions: await opfsBridge.scanOrphans(),
    };
  }

  async function clearSessionData(sessionId: string) {
    if (!sessionId) {
      return { ok: false, error: 'Missing session id' };
    }

    await opfsBridge.clearSession(sessionId);

    return { ok: true };
  }

  async function inspectRecoveryChunks(sessionId: string) {
    if (!sessionId) {
      return { ok: false, error: 'Missing session id' };
    }

    try {
      const manifestData = await readManifest(sessionId);
      const chunks = [...manifestData.chunks].sort((a, b) => a.index - b.index);
      const checks: RecoveryChunkCheck[] = [];

      for (const chunk of chunks) {
        let status: RecoveryChunkStatus = 'ok';
        let actualChecksum: string | null = null;
        const expectedChecksum = chunk.checksum || null;
        try {
          const data = await readChunkData(sessionId, chunk.index);
          actualChecksum = await sha256Hex(data);
          if (!expectedChecksum || actualChecksum !== expectedChecksum) {
            status = 'suspect';
          }
        } catch {
          status = 'missing';
        }

        checks.push({
          index: chunk.index,
          size: chunk.size,
          status,
          expectedChecksum,
          actualChecksum,
          included: status !== 'missing',
        });
      }

      return { ok: true, chunks: checks };
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
      };
    }
  }

  async function downloadRawChunks(sessionId: string) {
    if (!sessionId) {
      return { ok: false, error: 'Missing session id' };
    }

    try {
      const manifestData = await readManifest(sessionId);
      const orderedChunks = [...manifestData.chunks].sort((a, b) => a.index - b.index);
      if (!orderedChunks.length) {
        return { ok: false, error: 'No chunks found for this session' };
      }

      const baseName = `${sessionId}-raw`;
      const chunkExt = (manifestData.mimeType ?? '').includes('mp4') ? 'mp4' : 'webm';

      const items: RawDownloadItem[] = [];
      const manifestBlob = new Blob([JSON.stringify(manifestData, null, 2)], {
        type: 'application/json',
      });
      items.push({
        url: URL.createObjectURL(manifestBlob),
        filename: `${baseName}/manifest.json`,
      });

      for (const chunk of orderedChunks) {
        try {
          const data = await readChunkData(sessionId, chunk.index);
          const chunkBlob = new Blob([data], {
            type: manifestData.mimeType || 'application/octet-stream',
          });
          items.push({
            url: URL.createObjectURL(chunkBlob),
            filename: `${baseName}/chunk-${chunk.index}.${chunkExt}`,
          });
        } catch {
          // Skip missing chunks and continue exporting everything available.
        }
      }

      if (!items.length) {
        return { ok: false, error: 'No exportable files found for this session' };
      }

      scheduleRawExportUrlCleanup(items.map((item) => item.url));
      return { ok: true, items };
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
      };
    }
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
          void emitEvent(OffscreenEventType.PROCESS_PROGRESS, { progress });
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
    stopSystemAudioCheck();
    stopStorageMonitor();
    releasePreflightMicStream();

    if (mixTabSource) {
      try {
        mixTabSource.disconnect();
      } catch {}
      mixTabSource = null;
    }

    if (mixMicSource) {
      try {
        mixMicSource.disconnect();
      } catch {}
      mixMicSource = null;
    }
    if (mixTabGain) {
      try {
        mixTabGain.disconnect();
      } catch {}
      mixTabGain = null;
    }
    if (mixMicGain) {
      try {
        mixMicGain.disconnect();
      } catch {}
      mixMicGain = null;
    }

    mixDestination = null;
    if (mixAudioCtx) {
      await mixAudioCtx.close().catch(() => {});
      mixAudioCtx = null;
    }

    if (captureStream) {
      captureStream.getTracks().forEach((track) => track.stop());
    }
    if (tabCaptureStream) {
      tabCaptureStream.getTracks().forEach((track) => track.stop());
    }
    if (micCaptureStream) {
      micCaptureStream.getTracks().forEach((track) => track.stop());
    }
    captureStream = null;
    tabCaptureStream = null;
    micCaptureStream = null;
    recorder = null;
  }

  async function runMicPreflight(micDeviceId: string | null = null) {
    releasePreflightMicStream();
    try {
      const permissionStatus = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      if (permissionStatus.state === 'denied') {
        return { ok: false, error: 'MIC_PERMISSION_DENIED' };
      }
    } catch {
      // Some Chrome contexts may not expose permission query reliably.
      // Continue to getUserMedia and handle errors there.
    }

    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    try {
      stream = await requestMicStream(micDeviceId);

      audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      await wait(1_000);
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      const level = data.reduce((sum, value) => sum + value, 0) / data.length;
      const deviceLabel = stream.getAudioTracks()[0]?.label ?? null;

      source.disconnect();
      preflightMicStream = stream;
      stream = null;
      schedulePreflightMicHoldRelease();
      return { ok: true, level, deviceLabel };
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          return { ok: false, error: 'MIC_PERMISSION_PROMPT' };
        }
        if (error.name === 'NotFoundError') {
          return { ok: false, error: 'MIC_NOT_FOUND' };
        }
        if (error.name === 'NotReadableError') {
          return { ok: false, error: 'MIC_IN_USE' };
        }
      }
      return {
        ok: false,
        error: toNamedErrorMessage(error),
      };
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      await audioCtx?.close().catch(() => {});
    }
  }

  function startSystemAudioCheck(stream: MediaStream) {
    stopSystemAudioCheck();

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      void emitRuntimeSignal({ type: RuntimeMessageType.SYSTEM_AUDIO_ABSENT });
      return;
    }

    try {
      const audioStream = new MediaStream(audioTracks);
      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(audioStream);
      source.connect(analyser);

      systemAudioAudioCtx = audioCtx;
      systemAudioSource = source;

      systemAudioCheckTimer = setTimeout(() => {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const level = data.reduce((sum, value) => sum + value, 0) / data.length;

        if (level <= 0) {
          void emitRuntimeSignal({ type: RuntimeMessageType.SYSTEM_AUDIO_SILENT, level });
        } else {
          void emitRuntimeSignal({ type: RuntimeMessageType.SYSTEM_AUDIO_OK, level });
        }

        stopSystemAudioCheck();
      }, 2_000);
    } catch (error) {
      void emitRuntimeSignal({
        type: RuntimeMessageType.SYSTEM_AUDIO_ABSENT,
        error: toErrorMessage(error),
      });
      stopSystemAudioCheck();
    }
  }

  function stopSystemAudioCheck() {
    if (systemAudioCheckTimer) {
      clearTimeout(systemAudioCheckTimer);
      systemAudioCheckTimer = null;
    }

    if (systemAudioSource) {
      try {
        systemAudioSource.disconnect();
      } catch {}
      systemAudioSource = null;
    }

    if (systemAudioAudioCtx) {
      void systemAudioAudioCtx.close().catch(() => {});
      systemAudioAudioCtx = null;
    }
  }

  function startStorageMonitor() {
    stopStorageMonitor();
    storageMonitorInterval = setInterval(() => {
      void (async () => {
        try {
          const estimate = await navigator.storage.estimate();
          const availableMB = Math.max(0, ((estimate.quota ?? 0) - (estimate.usage ?? 0)) / (1024 * 1024));

          if (availableMB < 50) {
            await emitRuntimeSignal({
              type: RuntimeMessageType.AUTO_STOP_LOW_STORAGE,
              availableMB,
            });
            stopStorageMonitor();
            return;
          }

          if (availableMB < 100) {
            await emitRuntimeSignal({
              type: RuntimeMessageType.LOW_STORAGE_WARNING,
              availableMB,
            });
          }
        } catch {
          // Ignore transient storage-estimate failures.
        }
      })();
    }, 30_000);
  }

  function stopStorageMonitor() {
    if (storageMonitorInterval) {
      clearInterval(storageMonitorInterval);
      storageMonitorInterval = null;
    }
  }

  async function emitRuntimeSignal(payload: Record<string, unknown>) {
    try {
      await chrome.runtime.sendMessage(payload);
    } catch {
      // Background may be asleep between events; ignore.
    }
  }

  async function emitEvent(event: OffscreenEventTypeValue, payload: Record<string, unknown>) {
    try {
      await chrome.runtime.sendMessage({
        type: RuntimeMessageType.OFFSCREEN_EVENT,
        event,
        ...payload,
      });
    } catch {
      // Background may be asleep between events; ignore.
    }
  }

  function wait(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  function scheduleRawExportUrlCleanup(urls: string[]) {
    for (const url of urls) {
      rawExportUrls.add(url);
    }

    if (rawExportRevokeTimer) {
      clearTimeout(rawExportRevokeTimer);
    }

    rawExportRevokeTimer = setTimeout(() => {
      for (const url of rawExportUrls) {
        URL.revokeObjectURL(url);
      }
      rawExportUrls.clear();
      rawExportRevokeTimer = null;
    }, 10 * 60 * 1000);
  }

  async function validateBlob(blob: Blob, minimumDurationSeconds = 0): Promise<ValidationResult> {
    const checks = {
      size: blob.size > 50_000,
      header: await hasMp4FtypHeader(blob),
      duration: await checkDurationWithFallback(blob, minimumDurationSeconds),
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

  async function checkDurationWithFallback(blob: Blob, minimumDurationSeconds = 0): Promise<boolean> {
    if (minimumDurationSeconds <= 0 && blob.size > 1_000_000) return true;

    const isDurationValid = (value: number) =>
      Number.isFinite(value) &&
      value > 0 &&
      (minimumDurationSeconds <= 0 || value >= minimumDurationSeconds);

    const mediaDuration = await probeDuration(blob);
    if (isDurationValid(mediaDuration)) {
      return true;
    }

    const ffprobeDuration = await probeDurationViaFfprobe(blob);
    return isDurationValid(ffprobeDuration);
  }

  async function probeDurationViaFfprobe(blob: Blob): Promise<number> {
    let inputFile = '';
    let outputFile = '';

    try {
      const ff = await ensureFFmpeg();
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
      if (ffmpegLoaded && ffmpeg) {
        if (outputFile) await ffmpeg.deleteFile(outputFile).catch(() => {});
        if (inputFile) await ffmpeg.deleteFile(inputFile).catch(() => {});
      }
    }
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

  async function requestMicStream(micDeviceId: string | null = null) {
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (micDeviceId) {
      audioConstraints.deviceId = { exact: micDeviceId };
    }

    return await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });
  }

  function consumePreflightMicStream() {
    if (!preflightMicStream) return null;
    clearPreflightMicHoldRelease();
    const stream = preflightMicStream;
    preflightMicStream = null;
    return stream;
  }

  function clearPreflightMicHoldRelease() {
    if (!preflightMicHoldTimer) return;
    clearTimeout(preflightMicHoldTimer);
    preflightMicHoldTimer = null;
  }

  function releasePreflightMicStream() {
    clearPreflightMicHoldRelease();
    if (!preflightMicStream) return;
    preflightMicStream.getTracks().forEach((track) => track.stop());
    preflightMicStream = null;
  }

  function schedulePreflightMicHoldRelease() {
    clearPreflightMicHoldRelease();
    preflightMicHoldTimer = setTimeout(() => {
      releasePreflightMicStream();
    }, PREFLIGHT_MIC_HOLD_MS);
  }

  async function buildCaptureStream(
    tabStream: MediaStream,
    audioSource: AudioSource,
    micDeviceId: string | null,
  ) {
    const videoTracks = tabStream.getVideoTracks();
    if (!videoTracks.length) {
      throw new Error('Tab capture did not provide a video track');
    }

    if (audioSource === 'silent') {
      releasePreflightMicStream();
      return new MediaStream([...videoTracks]);
    }

    if (audioSource === 'tab') {
      releasePreflightMicStream();
      return new MediaStream([...videoTracks, ...tabStream.getAudioTracks()]);
    }

    if (audioSource === 'mic') {
      micCaptureStream = consumePreflightMicStream() ?? (await requestMicStream(micDeviceId));
      const micTracks = micCaptureStream.getAudioTracks();
      if (!micTracks.length) {
        throw new Error('Microphone capture did not provide an audio track');
      }
      return new MediaStream([...videoTracks, ...micTracks]);
    }

    try {
      micCaptureStream = consumePreflightMicStream() ?? (await requestMicStream(micDeviceId));
      const micTracks = micCaptureStream.getAudioTracks();
      if (!micTracks.length) {
        throw new Error('Microphone capture did not provide an audio track');
      }

      mixAudioCtx = new AudioContext();
      mixDestination = mixAudioCtx.createMediaStreamDestination();

      const tabAudioTracks = tabStream.getAudioTracks();
      if (tabAudioTracks.length) {
        mixTabSource = mixAudioCtx.createMediaStreamSource(new MediaStream(tabAudioTracks));
        mixTabGain = mixAudioCtx.createGain();
        mixTabGain.gain.value = 1;
        mixTabSource.connect(mixTabGain);
        mixTabGain.connect(mixDestination);
      }

      mixMicSource = mixAudioCtx.createMediaStreamSource(new MediaStream(micTracks));
      mixMicGain = mixAudioCtx.createGain();
      mixMicGain.gain.value = 1.4;
      mixMicSource.connect(mixMicGain);
      mixMicGain.connect(mixDestination);
      await mixAudioCtx.resume().catch(() => {});

      const mixedAudioTracks = mixDestination.stream.getAudioTracks();
      if (!mixedAudioTracks.length) {
        throw new Error('Failed to build mixed audio stream');
      }

      return new MediaStream([...videoTracks, ...mixedAudioTracks]);
    } catch (error) {
      const currentMicStream: MediaStream | null = micCaptureStream;
      const liveMicTracks: MediaStreamTrack[] = currentMicStream
        ? currentMicStream
            .getAudioTracks()
            .filter((track: MediaStreamTrack) => track.readyState === 'live')
        : [];

      if (mixTabSource) {
        try {
          mixTabSource.disconnect();
        } catch {}
        mixTabSource = null;
      }
      if (mixMicSource) {
        try {
          mixMicSource.disconnect();
        } catch {}
        mixMicSource = null;
      }
      if (mixTabGain) {
        try {
          mixTabGain.disconnect();
        } catch {}
        mixTabGain = null;
      }
      if (mixMicGain) {
        try {
          mixMicGain.disconnect();
        } catch {}
        mixMicGain = null;
      }
      mixDestination = null;
      if (mixAudioCtx) {
        await mixAudioCtx.close().catch(() => {});
        mixAudioCtx = null;
      }

      await emitRuntimeSignal({
        type: RuntimeMessageType.MIC_MIX_FAILED,
        reason: toNamedErrorMessage(error),
        fallback: liveMicTracks.length > 0 ? 'mic_only' : 'tab_only',
      });

      if (liveMicTracks.length > 0) {
        return new MediaStream([...videoTracks, ...liveMicTracks]);
      }

      if (currentMicStream) {
        currentMicStream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
        micCaptureStream = null;
      }

      // Last-resort fallback keeps recording alive even when mic mix fails completely.
      return new MediaStream([...videoTracks, ...tabStream.getAudioTracks()]);
    }
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
