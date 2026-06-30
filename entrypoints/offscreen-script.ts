import type { ValidationResult } from '@/lib/recording';
import {
  OffscreenEventType,
  RuntimeMessageType,
  type AudioSource,
  type CaptureQuality,
  type CaptureResolvedQuality,
  type MicPreflightMessage,
  type OffscreenEventTypeValue,
  type TestOrphanFixtureSession,
  type TestPermissionState,
} from '@/lib/messages';
import { debugWarn } from '@/lib/runtime-log';
import { MessageRouter } from '@/lib/message-router';
import {
  getRuntimeHintsFromNavigator,
  normalizeResolvedCaptureQuality,
  resolveCapturePreset,
} from '@/lib/capture-presets';
import { OpfsBridge } from './offscreen/storage/opfs-bridge';
import { RecoveryService } from './offscreen/recovery/recovery-service';
import { Processor } from './offscreen/processing/processor';
import type { SessionManifest } from './offscreen/types';
import {
  buildTabCaptureConstraints,
  getCaptureProfileByPreset,
  normalizeCaptureQuality,
  resolveCapturePlan,
} from './offscreen/utils';
import {
  resolveWebCodecsRecordingFormat,
  WebCodecsPipeline,
  type WebCodecsPipelineStats,
} from './offscreen/webcodecs';
import {
  buildDownloadFileName,
  normalizeAudioSource,
  normalizeMicDeviceId,
  toErrorMessage,
} from './background/utils';
import {
  buildCaptureFallbackReason,
  formatPresetShortLabel,
} from './offscreen/media/capture-fallback';
import {
  hasMp4FtypHeader,
  hasWebmEbmlHeader,
} from './offscreen/media/container-probe';
import { classifyMicPermissionRequestError } from '@/lib/testing/mic-permission';
import { isTestCaptureStreamId } from '@/lib/testing/capture-stream';
import { normalizeTestOrphanFixtureSession } from '@/lib/testing/orphan-fixture';

const CHUNK_DURATION_SECONDS = 10;
const CHUNK_INTERVAL_MS = CHUNK_DURATION_SECONDS * 1000;
const PREFLIGHT_MIC_HOLD_MS = 60_000;

export default defineUnlistedScript(() => {
  const opfsBridge = new OpfsBridge();
  const recovery = new RecoveryService({
    opfs: opfsBridge,
    sha256: (data) => sha256Hex(data),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  });
  const processor = new Processor({
    opfs: opfsBridge,
    emit: (event, payload) => emitEvent(event, payload),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    probeVideoDuration: (blob) => probeVideoDuration(blob),
    importFFmpegCtor: async () => (await import('@ffmpeg/ffmpeg')).FFmpeg,
    ffmpegLoadConfig: {
      classWorkerURL: chrome.runtime.getURL('ffmpeg/worker.js'),
      coreURL: chrome.runtime.getURL('ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('ffmpeg-core.wasm'),
    },
    isRecorderActive: () => recorder?.state === 'recording',
    chunkDurationSeconds: CHUNK_DURATION_SECONDS,
  });

  let recorder: MediaRecorder | null = null;
  let captureStream: MediaStream | null = null;
  let tabCaptureStream: MediaStream | null = null;
  let syntheticTabCaptureCanvas: HTMLCanvasElement | null = null;
  let syntheticTabCaptureInterval: ReturnType<typeof setInterval> | null = null;
  let micCaptureStream: MediaStream | null = null;
  let preflightMicStream: MediaStream | null = null;
  let preflightMicHoldTimer: ReturnType<typeof setTimeout> | null = null;

  let activeSessionId: string | null = null;
  let manifest: SessionManifest | null = null;
  let activeCaptureQuality: CaptureQuality = 'auto';
  let activeResolvedPreset: CaptureResolvedQuality = '1080p30';
  let chunkCount = 0;
  let webcodecsStreamHighWater = 0;
  let webcodecsManifestTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingStop = false;
  let stopFinalDataPromise: Promise<void> | null = null;
  let resolveStopFinalData: (() => void) | null = null;
  let stopFinalDataTimeout: ReturnType<typeof setTimeout> | null = null;
  let stopCompletionPromise: Promise<void> | null = null;
  let resolveStopCompletion: (() => void) | null = null;
  let writeQueue: Promise<void> = Promise.resolve();
  let writeError: Error | null = null;

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

  // Signal readiness early. If background is not listening yet, ping-based readiness still succeeds.
  void chrome.runtime.sendMessage({ type: RuntimeMessageType.OFFSCREEN_READY }).catch(() => {});

  const router = new MessageRouter();

  router
    .on(RuntimeMessageType.OFFSCREEN_START, (msg) =>
      startRecording(
        String(msg.sessionId),
        String(msg.streamId ?? ''),
        normalizeAudioSource(msg.audioSource),
        normalizeMicDeviceId(msg.micDeviceId),
        normalizeCaptureQuality(msg.quality),
        String(msg.exportBaseName ?? ''),
        typeof msg.recordingStartTime === 'number' ? msg.recordingStartTime : undefined,
      ),
    )
    .on(RuntimeMessageType.OFFSCREEN_STOP, () => stopRecording())
    .on(RuntimeMessageType.OFFSCREEN_PROCESS, (msg) => {
      const chunkIndexes = Array.isArray(msg.chunkIndexes)
        ? msg.chunkIndexes
            .map((value: unknown) => Number(value))
            .filter((value: number) => Number.isInteger(value) && value >= 0)
        : undefined;
      return processor.processRecording(String(msg.sessionId), chunkIndexes);
    })
    .on(RuntimeMessageType.OFFSCREEN_VALIDATE, () => processor.validateLatestOutput())
    .on(RuntimeMessageType.MIC_PREFLIGHT, (msg) =>
      runMicPreflight(
        normalizeMicDeviceId(msg.micDeviceId),
        normalizeMicPermissionState((msg as MicPreflightMessage).permissionState),
      ),
    )
    .on(RuntimeMessageType.OFFSCREEN_RELEASE_PREFLIGHT_MIC, () => {
      releasePreflightMicStream();
      return { ok: true };
    })
    .on(RuntimeMessageType.OFFSCREEN_FORCE_CLEANUP, () => forceCleanupCapture())
    .on(RuntimeMessageType.OFFSCREEN_PAUSE, () => pauseRecording())
    .on(RuntimeMessageType.OFFSCREEN_RESUME, () => resumeRecording())
    .on(RuntimeMessageType.OFFSCREEN_SCAN_ORPHANS, () => recovery.scanOrphanedSessions())
    .on(RuntimeMessageType.OFFSCREEN_TEST_SEED_ORPHANS, (msg) => {
      const sessions = Array.isArray(msg.sessions)
        ? msg.sessions
            .map((session: unknown) => normalizeTestOrphanFixtureSession(session))
            .filter(Boolean)
        : [];
      return recovery.seedOrphanedSessions(sessions as TestOrphanFixtureSession[]);
    })
    .on(RuntimeMessageType.OFFSCREEN_CLEAR_SESSION, (msg) =>
      recovery.clearSessionData(String(msg.sessionId ?? '')),
    )
    .on(RuntimeMessageType.OFFSCREEN_RECOVERY_INSPECT, (msg) =>
      recovery.inspectRecoveryChunks(String(msg.sessionId ?? '')),
    )
    .on(RuntimeMessageType.OFFSCREEN_DOWNLOAD_RAW_CHUNKS, (msg) =>
      recovery.downloadRawChunks(String(msg.sessionId ?? '')),
    )
    .on(RuntimeMessageType.OFFSCREEN_STATUS, () => ({
      alive: true,
      isRecording: recorder?.state === 'recording',
      isWebCodecsRecording: isWebCodecsRecording(),
      chunkCount,
      sessionId: activeSessionId,
      hasOutput: Boolean(processor.outputUrl),
    }))
    // WebCodecs pipeline handlers
    .on(RuntimeMessageType.WEBCODECS_CHECK_SUPPORT, (msg) => handleCheckWebCodecsSupport(msg.quality))
    .on(RuntimeMessageType.OFFSCREEN_START_WEBCODECS, (msg) => handleStartWebCodecs(msg))
    .on(RuntimeMessageType.OFFSCREEN_STOP_WEBCODECS, () => handleStopWebCodecs());

  chrome.runtime.onMessage.addListener(router.dispatch);

  async function handleCheckWebCodecsSupport(quality: unknown) {
    try {
      return await checkWebCodecsSupport(normalizeCaptureQuality(quality));
    } catch (error) {
      debugWarn('[Offscreen] WebCodecs check error:', error);
      return {
        ok: false,
        error: toErrorMessage(error),
        videoSupported: false,
        audioSupported: false,
        hardwareAcceleration: false,
        fallbackReason: toErrorMessage(error),
      };
    }
  }

  async function handleStartWebCodecs(msg: {
    streamId?: unknown;
    quality?: unknown;
    sessionId?: unknown;
    audioSource?: unknown;
    micDeviceId?: unknown;
    exportBaseName?: unknown;
    recordingStartTime?: unknown;
  }) {
    try {
      const streamId = String(msg.streamId ?? '');
      const quality = normalizeCaptureQuality(msg.quality);
      const sessionId = String(msg.sessionId ?? '');
      const audioSource = normalizeAudioSource(msg.audioSource);
      const micDeviceId = normalizeMicDeviceId(msg.micDeviceId);

      if (!streamId) {
        return { ok: false, error: 'Missing stream ID' };
      }

      // Get the tab capture stream using the same method as MediaRecorder
      const tabStreamResolution = await getTabStreamByIdWithFallback(streamId, quality);
      const tabStream = tabStreamResolution.stream;
      tabCaptureStream = tabStream;

      // Build capture stream with audio mixing (reuses the same logic as MediaRecorder path)
      const stream = await buildCaptureStream(tabStream, audioSource, micDeviceId);
      captureStream = stream;

      const result = await startWebCodecsRecording(
        sessionId,
        stream,
        tabStreamResolution.requestedPreset,
        tabStreamResolution.resolvedPreset,
        tabStreamResolution.fallbackReason,
        String(msg.exportBaseName ?? ''),
        typeof msg.recordingStartTime === 'number' ? msg.recordingStartTime : undefined,
      );

      if (!result.ok) {
        debugWarn('[Offscreen] WebCodecs start failed:', result.error);
        await cleanupMedia();
      }

      return result;
    } catch (error) {
      console.error('[Offscreen] WebCodecs start error:', error);
      await cleanupMedia();
      return { ok: false, error: toNamedErrorMessage(error) };
    }
  }

  async function handleStopWebCodecs() {
    try {
      const result = await stopWebCodecsRecording();

      // Cleanup streams
      await cleanupMedia();

      return result;
    } catch (error) {
      cleanupWebCodecsPipeline();
      await cleanupMedia().catch(() => {});
      return { ok: false, error: toNamedErrorMessage(error) };
    }
  }

  async function getTabStreamByIdWithFallback(streamId: string, captureQuality: CaptureQuality) {
    const plan = resolveCapturePlan(captureQuality, getRuntimeHintsFromNavigator());
    const attemptErrors: string[] = [];

    for (const preset of plan.fallbackChain) {
      try {
        const stream = await getTabStreamByPreset(streamId, preset);
        return {
          stream,
          requestedPreset: plan.requestedPreset,
          resolvedPreset: preset,
          fallbackReason: buildCaptureFallbackReason(
            plan.requestedPreset,
            plan.autoSelectedPreset,
            preset,
            plan.fallbackChain,
            attemptErrors,
          ),
        };
      } catch (error) {
        attemptErrors.push(`${preset}: ${toNamedErrorMessage(error)}`);
      }
    }

    throw new Error(
      `Unable to start tab capture for "${plan.requestedPreset}" (${attemptErrors.join(' | ')})`,
    );
  }

  async function startRecording(
    nextSessionId: string,
    streamId: string,
    audioSource: AudioSource,
    micDeviceId: string | null,
    captureQuality: CaptureQuality,
    exportBaseName = '',
    recordingStartTime?: number,
  ) {
    if (recorder?.state === 'recording') {
      return { ok: false, error: 'Recorder is already active' };
    }

    if (!streamId) {
      return { ok: false, error: 'Missing tab stream id' };
    }

    try {
      const streamResolution = await getTabStreamByIdWithFallback(streamId, captureQuality);
      activeCaptureQuality = streamResolution.requestedPreset;
      activeResolvedPreset = streamResolution.resolvedPreset;
      const captureProfile = getCaptureProfileByPreset(activeResolvedPreset);
      tabCaptureStream = streamResolution.stream;
      captureStream = await buildCaptureStream(tabCaptureStream, audioSource, micDeviceId);

      activeSessionId = nextSessionId;
      chunkCount = 0;
      pendingStop = false;
      writeError = null;
      writeQueue = Promise.resolve();

      manifest = {
        sessionId: nextSessionId,
        exportBaseName: exportBaseName || undefined,
        startTime: recordingStartTime ?? Date.now(),
        recordingQuality: activeCaptureQuality,
        recordingResolvedQuality: activeResolvedPreset,
        chunks: [],
        totalDuration: 0,
        status: 'recording',
      };

      const mimeType = pickMimeType();
      recorder = new MediaRecorder(captureStream, {
        mimeType,
        videoBitsPerSecond: captureProfile.videoBitsPerSecond,
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
      // 4.2: FFmpeg stays cold-path only (processing/recovery). No start-time prewarm.
      return {
        ok: true,
        outputMimeType: recorder.mimeType || mimeType,
        fileName: buildDownloadFileName(
          manifest.exportBaseName ?? nextSessionId,
          recorder.mimeType || mimeType,
        ),
        requestedPreset: activeCaptureQuality,
        resolvedPreset: activeResolvedPreset,
        fallbackReason: streamResolution.fallbackReason,
      };
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

  function scheduleWebcodecsManifestUpdate() {
    if (manifest?.recordingKind !== 'webcodecs-opfs') return;
    if (webcodecsManifestTimer) return;
    webcodecsManifestTimer = setTimeout(() => {
      webcodecsManifestTimer = null;
      void (async () => {
        if (!manifest || manifest.recordingKind !== 'webcodecs-opfs' || !activeSessionId) return;
        try {
          manifest.streamBytesWritten = webcodecsStreamHighWater;
          await writeManifest();
        } catch {
          // Best-effort; recording continues without blocking on manifest IO.
        }
      })();
    }, 2500);
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

    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {}
    }

    if (captureStream) {
      captureStream.getTracks().forEach((track) => track.stop());
    }
    if (tabCaptureStream) {
      tabCaptureStream.getTracks().forEach((track) => track.stop());
    }
    if (syntheticTabCaptureInterval) {
      clearInterval(syntheticTabCaptureInterval);
      syntheticTabCaptureInterval = null;
    }
    syntheticTabCaptureCanvas = null;
    if (micCaptureStream) {
      micCaptureStream.getTracks().forEach((track) => track.stop());
    }
    captureStream = null;
    tabCaptureStream = null;
    micCaptureStream = null;
    recorder = null;
  }

  async function forceCleanupCapture() {
    try {
      pendingStop = false;
      clearFinalStopDataWait();
      resolveStopCompletion?.();
      resolveStopCompletion = null;
      stopCompletionPromise = null;

      if (webcodecsPipeline) {
        cleanupWebCodecsPipeline();
      }

      await cleanupMedia();
      activeSessionId = null;
      return { ok: true };
    } catch (error) {
      cleanupWebCodecsPipeline();
      await cleanupMedia().catch(() => {});
      return { ok: false, error: toNamedErrorMessage(error) };
    }
  }

  function normalizeMicPermissionState(
    value: unknown,
  ): TestPermissionState | PermissionState | null {
    if (
      value === 'unset' ||
      value === 'prompt' ||
      value === 'granted' ||
      value === 'denied'
    ) {
      return value;
    }
    return null;
  }

  async function runMicPreflight(
    micDeviceId: string | null = null,
    permissionState: TestPermissionState | PermissionState | null = null,
  ) {
    releasePreflightMicStream();
    try {
      const resolvedPermissionState =
        permissionState ?? (await resolveMicPermissionStateFromBrowser());
      if (resolvedPermissionState === 'denied') {
        return { ok: false, error: 'MIC_PERMISSION_DENIED' };
      }
      if (resolvedPermissionState === 'prompt') {
        return { ok: false, error: 'MIC_PERMISSION_PROMPT' };
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
      const classified = classifyMicPermissionRequestError(error);
      if (classified) {
        return { ok: false, error: classified };
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

  async function resolveMicPermissionStateFromBrowser(): Promise<TestPermissionState | PermissionState | null> {
    try {
      const permissionStatus = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      return permissionStatus.state;
    } catch {
      return null;
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

  // Read media duration via an HTMLVideoElement metadata load. Injected into the
  // Processor as its only `document`-bound dependency.
  function probeVideoDuration(blob: Blob): Promise<number> {
    return new Promise<number>((resolve) => {
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
  }

  function createSyntheticTabCaptureStream() {
    if (syntheticTabCaptureCanvas) {
      return syntheticTabCaptureCanvas.captureStream(30);
    }

    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Synthetic test capture canvas is unavailable');
    }

    let frame = 0;
    const draw = () => {
      const progress = (frame % 360) / 360;
      const offset = Math.round(progress * 255);
      context.fillStyle = `rgb(${18 + offset}, ${28 + offset / 2}, ${42 + offset / 3})`;
      context.fillRect(0, 0, canvas.width, canvas.height);

      context.fillStyle = 'rgba(255, 255, 255, 0.14)';
      for (let i = 0; i < 14; i += 1) {
        const x = ((frame * 11) + i * 120) % (canvas.width + 180) - 180;
        context.fillRect(x, 60 + i * 40, 160, 10);
      }

      context.fillStyle = 'rgba(0, 0, 0, 0.28)';
      context.fillRect(60, 120, canvas.width - 120, canvas.height - 240);

      context.fillStyle = '#f9fafb';
      context.font = 'bold 48px system-ui, sans-serif';
      context.fillText('Jot test capture', 100, 210);
      context.font = '28px system-ui, sans-serif';
      context.fillText(`frame ${frame}`, 100, 270);
      context.fillText(new Date().toISOString(), 100, 320);
      frame += 1;
    };

    draw();
    syntheticTabCaptureInterval = setInterval(draw, 1000 / 30);
    syntheticTabCaptureCanvas = canvas;
    return canvas.captureStream(30);
  }

  async function getTabStreamByPreset(streamId: string, resolvedPreset: CaptureResolvedQuality) {
    if (isTestCaptureStreamId(streamId)) {
      return createSyntheticTabCaptureStream();
    }

    const video = buildTabCaptureConstraints(streamId, resolvedPreset);

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

  async function sha256Hex(data: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
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

  // ============================================================
  // EXPERIMENTAL: WebCodecs Pipeline
  // ============================================================

  let webcodecsPipeline: WebCodecsPipeline | null = null;
  let webcodecsPipelineStartTime: number | null = null;

  async function resolveWebCodecsFormatForPreset(
    requestedPreset: CaptureQuality,
    preferredResolvedPreset?: CaptureResolvedQuality,
  ) {
    const plan = resolveCapturePreset(requestedPreset, getRuntimeHintsFromNavigator());
    const planFallbackChain = [...plan.fallbackChain];
    const preferredIndex =
      preferredResolvedPreset == null ? -1 : planFallbackChain.indexOf(preferredResolvedPreset);
    const candidateTail =
      preferredIndex >= 0 ? planFallbackChain.slice(preferredIndex) : planFallbackChain;
    const orderedCandidates: CaptureResolvedQuality[] = [];
    if (preferredResolvedPreset) {
      orderedCandidates.push(preferredResolvedPreset);
    }
    for (const candidate of candidateTail) {
      if (!orderedCandidates.includes(candidate)) {
        orderedCandidates.push(candidate);
      }
    }

    let lastFailure: string | null = null;
    for (const resolvedPreset of orderedCandidates) {
      const resolved = await resolveWebCodecsRecordingFormat(resolvedPreset);
      if (resolved.videoSupported) {
        const fallbackReason =
          resolvedPreset !== orderedCandidates[0]
            ? `WebCodecs fell back to ${formatPresetShortLabel(resolvedPreset)}.`
            : null;
        return {
          resolved,
          resolvedPreset,
          fallbackReason,
          requestedPreset: plan.requestedPreset,
        };
      }
      lastFailure = resolved.fallbackReason ?? `Unsupported format for ${resolvedPreset}`;
    }

    return {
      resolved: null,
      resolvedPreset: orderedCandidates[orderedCandidates.length - 1] ?? '1080p30',
      fallbackReason: lastFailure ?? 'No supported WebCodecs format found',
      requestedPreset: plan.requestedPreset,
    };
  }

  async function checkWebCodecsSupport(quality: CaptureQuality) {
    try {
      // Check if WebCodecs APIs exist
      const hasVideoEncoder = typeof VideoEncoder !== 'undefined';
      const hasAudioEncoder = typeof AudioEncoder !== 'undefined';
      if (!hasVideoEncoder || !hasAudioEncoder) {
        return {
          ok: false,
          error: 'WebCodecs API not available in this context',
          videoSupported: false,
          audioSupported: false,
          hardwareAcceleration: false,
          fallbackReason: 'WebCodecs API not available',
          container: 'mp4' as const,
          outputMimeType: 'video/mp4',
          opfsStreamFile: 'webcodecs-stream.mp4',
          resolvedPreset: '1080p30' as const,
        };
      }

      const formatResolution = await resolveWebCodecsFormatForPreset(quality);
      if (!formatResolution.resolved) {
        return {
          ok: false,
          error: formatResolution.fallbackReason ?? 'No supported WebCodecs format found',
          videoSupported: false,
          audioSupported: false,
          hardwareAcceleration: false,
          fallbackReason: formatResolution.fallbackReason,
          container: 'mp4' as const,
          outputMimeType: 'video/mp4',
          opfsStreamFile: 'webcodecs-stream.mp4',
          resolvedPreset: formatResolution.resolvedPreset,
        };
      }

      const result = await WebCodecsPipeline.checkCapabilities(formatResolution.resolvedPreset);
      return {
        ok: true,
        ...result,
        requestedPreset: formatResolution.requestedPreset,
        resolvedPreset: formatResolution.resolvedPreset,
        fallbackReason:
          formatResolution.fallbackReason ?? result.fallbackReason ?? null,
      };
    } catch (error) {
      debugWarn('[Offscreen] checkWebCodecsSupport error:', error);
      return {
        ok: false,
        error: toErrorMessage(error),
        videoSupported: false,
        audioSupported: false,
        hardwareAcceleration: false,
        fallbackReason: toErrorMessage(error),
        container: 'mp4' as const,
        outputMimeType: 'video/mp4',
        opfsStreamFile: 'webcodecs-stream.mp4',
        resolvedPreset: '1080p30' as const,
      };
    }
  }

  async function startWebCodecsRecording(
    nextSessionId: string,
    stream: MediaStream,
    requestedPreset: CaptureQuality,
    preferredResolvedPreset: CaptureResolvedQuality,
    captureFallbackReason: string | null,
    exportBaseName = '',
    recordingStartTime?: number,
  ) {
    if (webcodecsPipeline?.isRunning()) {
      return { ok: false, error: 'WebCodecs pipeline already running' };
    }

    try {
      const formatResolution = await resolveWebCodecsFormatForPreset(
        requestedPreset,
        preferredResolvedPreset,
      );
      if (!formatResolution.resolved?.videoSupported) {
        return {
          ok: false,
          error: `Video encoding not supported: ${formatResolution.fallbackReason ?? 'Unknown reason'}`,
        };
      }
      const resolved = formatResolution.resolved;

      activeSessionId = nextSessionId;
      activeCaptureQuality = formatResolution.requestedPreset;
      activeResolvedPreset = formatResolution.resolvedPreset;
      chunkCount = 0;
      webcodecsStreamHighWater = 0;
      if (webcodecsManifestTimer) {
        clearTimeout(webcodecsManifestTimer);
        webcodecsManifestTimer = null;
      }

      manifest = {
        sessionId: nextSessionId,
        exportBaseName: exportBaseName || undefined,
        startTime: recordingStartTime ?? Date.now(),
        recordingQuality: activeCaptureQuality,
        recordingResolvedQuality: activeResolvedPreset,
        mimeType: resolved.outputMimeType,
        chunks: [],
        totalDuration: 0,
        status: 'recording',
        recordingKind: 'webcodecs-opfs',
        streamBytesWritten: 0,
        webCodecsOpfsStreamFile: resolved.opfsStreamFile,
      };
      await writeManifest();

      const streamSessionId = nextSessionId;
      const opfsStreamFile = resolved.opfsStreamFile;
      const persistWrite = async (position: number, data: ArrayBuffer) => {
        await opfsBridge.writeWebCodecsRange(streamSessionId, position, data, opfsStreamFile);
        webcodecsStreamHighWater = Math.max(webcodecsStreamHighWater, position + data.byteLength);
        scheduleWebcodecsManifestUpdate();
      };

      webcodecsPipeline = new WebCodecsPipeline({
        requestedPreset: activeCaptureQuality,
        resolvedPreset: activeResolvedPreset,
        resolvedFormat: resolved,
        opfsPersist: {
          writeRange: persistWrite,
          readComplete: () => opfsBridge.readWebCodecsStream(streamSessionId, opfsStreamFile),
        },
        onProgress: (stats) => {
          // Emit progress events to background
          void emitEvent(OffscreenEventType.CHUNK_WRITTEN, {
            chunkCount: Math.floor(stats.framesEncoded / 300), // ~10 seconds at 30fps
          });
          void emitEvent(OffscreenEventType.WEBCODECS_STATS, {
            webCodecsStats: {
              framesEncoded: stats.framesEncoded,
              bytesWritten: stats.bytesWritten,
              droppedFrames: stats.droppedFrames,
              hardwareAccelerated: stats.hardwareAccelerated,
              memoryPressureTier: stats.memoryPressureTier,
              videoBitrateBps: stats.videoBitrateBps,
            },
          });
        },
        onError: (error) => {
          const isExpectedInterruption =
            error.message === 'Recording source ended because the tab was closed or navigated';
          if (isExpectedInterruption) {
            console.warn('[WebCodecs] Source tab ended, stopping recorder gracefully', error);
          } else {
            console.error('[WebCodecs] Pipeline error', error);
            void emitEvent(OffscreenEventType.ERROR, { error: error.message });
          }
          // Auto-stop on fatal errors (e.g. stream ended, encoder crashed)
          // Emit a signal so background can trigger a graceful stop
          void emitRuntimeSignal({
            type: RuntimeMessageType.WEBCODECS_FATAL_ERROR,
            error: error.message,
          });
        },
      });

      await webcodecsPipeline.start(stream);
      webcodecsPipelineStartTime = Date.now();

      return {
        ok: true,
        hardwareAccelerated: resolved.hardwareAcceleration,
        outputMimeType: resolved.outputMimeType,
        fileName: buildDownloadFileName(
          manifest.exportBaseName ?? nextSessionId,
          resolved.outputMimeType,
        ),
        requestedPreset: activeCaptureQuality,
        resolvedPreset: activeResolvedPreset,
        fallbackReason:
          [captureFallbackReason, formatResolution.fallbackReason, resolved.fallbackReason]
            .filter((reason): reason is string => Boolean(reason))
            .join(' ') || null,
      };
    } catch (error) {
      console.error('[WebCodecs] Failed to start', error);
      cleanupWebCodecsPipeline();
      return {
        ok: false,
        error: toNamedErrorMessage(error),
      };
    }
  }

  async function stopWebCodecsRecording() {
    if (!webcodecsPipeline) {
      return { ok: false, error: 'No WebCodecs recording in progress' };
    }

    try {
      const stopStartTime = performance.now();

      const outputBuffer = await webcodecsPipeline.stop();
      const stopDurationMs = performance.now() - stopStartTime;
      const finalStats = webcodecsPipeline.getStats();

      const outMime = finalStats.outputMimeType;

      // Create blob and URL (the processor owns the shared output store)
      const blob = new Blob([outputBuffer], { type: outMime });
      const outputUrl = processor.adoptOutput(blob);

      // Validate the output
      const validation = await validateWebCodecsOutput(blob);

      if (manifest?.recordingKind === 'webcodecs-opfs') {
        if (webcodecsManifestTimer) {
          clearTimeout(webcodecsManifestTimer);
          webcodecsManifestTimer = null;
        }
        manifest.status = 'complete';
        manifest.streamBytesWritten = outputBuffer.byteLength;
        await writeManifest();
      }

      cleanupWebCodecsPipeline();

      // Emit final event
      await emitEvent(OffscreenEventType.FINAL_CHUNK_WRITTEN, {
        sessionId: activeSessionId,
        chunkCount: Math.floor(finalStats.framesEncoded / 300),
      });

      return {
        ok: true,
        outputUrl,
        outputMimeType: outMime,
        fileName: buildDownloadFileName(
          manifest?.exportBaseName ?? activeSessionId,
          outMime,
        ),
        outputSize: outputBuffer.byteLength,
        stopDurationMs,
        stats: finalStats,
        validation,
      };
    } catch (error) {
      console.error('[WebCodecs] Failed to stop', error);
      cleanupWebCodecsPipeline();
      return {
        ok: false,
        error: toNamedErrorMessage(error),
      };
    }
  }

  async function validateWebCodecsOutput(blob: Blob): Promise<ValidationResult> {
    const checks = {
      size: blob.size > 1000,
      header: false,
      duration: false,
    };

    try {
      const isWebm = blob.type.includes('webm');
      checks.header = isWebm ? await hasWebmEbmlHeader(blob) : await hasMp4FtypHeader(blob);

      const videoUrl = URL.createObjectURL(blob);
      try {
        const duration = await new Promise<number>((resolve, reject) => {
          const video = document.createElement('video');
          video.preload = 'metadata';
          video.onloadedmetadata = () => resolve(video.duration);
          video.onerror = () => reject(new Error('Failed to load video metadata'));
          video.src = videoUrl;
        });
        checks.duration = duration > 0 && Number.isFinite(duration);
      } finally {
        URL.revokeObjectURL(videoUrl);
      }
    } catch {
      // Validation checks remain false
    }

    return {
      passed: checks.size && checks.header && checks.duration,
      checks,
    };
  }

  function cleanupWebCodecsPipeline() {
    if (webcodecsManifestTimer) {
      clearTimeout(webcodecsManifestTimer);
      webcodecsManifestTimer = null;
    }
    webcodecsPipeline = null;
    webcodecsPipelineStartTime = null;
  }

  function isWebCodecsRecording() {
    return webcodecsPipeline?.isRunning() ?? false;
  }
});
