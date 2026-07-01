import {
  RuntimeMessageType,
  type MicPreflightMessage,
  type TestOrphanFixtureSession,
} from '@/lib/messages';
import { MessageRouter } from '@/lib/message-router';
import { OpfsBridge } from './offscreen/storage/opfs-bridge';
import { RecoveryService } from './offscreen/recovery/recovery-service';
import { Processor } from './offscreen/processing/processor';
import { CaptureSession } from './offscreen/capture-session';
import { createCaptureSessionDeps } from './offscreen/platform';
import {
  normalizeAudioSource,
  normalizeMicDeviceId,
} from './background/utils';
import { normalizeCaptureQuality } from './offscreen/utils';
import { normalizeTestOrphanFixtureSession } from '@/lib/testing/orphan-fixture';

export default defineUnlistedScript(() => {
  const opfsBridge = new OpfsBridge();

  const recovery = new RecoveryService({
    opfs: opfsBridge,
    sha256: async (data) => {
      const digest = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  });

  const processor = new Processor({
    opfs: opfsBridge,
    emit: async (event, payload) => {
      try {
        await chrome.runtime.sendMessage({ type: RuntimeMessageType.OFFSCREEN_EVENT, event, ...payload });
      } catch {}
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    probeVideoDuration: (blob) =>
      new Promise<number>((resolve) => {
        const video = document.createElement('video');
        const url = URL.createObjectURL(blob);
        const finalize = (value: number) => { URL.revokeObjectURL(url); video.remove(); resolve(value); };
        video.preload = 'metadata';
        video.onloadedmetadata = () => finalize(video.duration);
        video.onerror = () => finalize(0);
        video.src = url;
      }),
    importFFmpegCtor: async () => (await import('@ffmpeg/ffmpeg')).FFmpeg,
    ffmpegLoadConfig: {
      classWorkerURL: chrome.runtime.getURL('ffmpeg/worker.js'),
      coreURL: chrome.runtime.getURL('ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('ffmpeg-core.wasm'),
    },
    isRecorderActive: () => session.getStatus().isRecording,
    chunkDurationSeconds: 10,
  });

  const sessionDeps = createCaptureSessionDeps(opfsBridge, processor);
  const session = new CaptureSession(sessionDeps);

  // Signal readiness early. If background is not listening yet, ping-based readiness still succeeds.
  void chrome.runtime.sendMessage({ type: RuntimeMessageType.OFFSCREEN_READY }).catch(() => {});

  const router = new MessageRouter();

  function normalizeMicPermissionState(value: unknown) {
    if (value === 'unset' || value === 'prompt' || value === 'granted' || value === 'denied') {
      return value as 'unset' | 'prompt' | 'granted' | 'denied';
    }
    return null;
  }

  router
    .on(RuntimeMessageType.OFFSCREEN_START, (msg) =>
      session.startRecording(
        String(msg.sessionId),
        String(msg.streamId ?? ''),
        normalizeAudioSource(msg.audioSource),
        normalizeMicDeviceId(msg.micDeviceId),
        normalizeCaptureQuality(msg.quality),
        String(msg.exportBaseName ?? ''),
        typeof msg.recordingStartTime === 'number' ? msg.recordingStartTime : undefined,
      ),
    )
    .on(RuntimeMessageType.OFFSCREEN_STOP, () => session.stopRecording())
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
      session.runMicPreflight(
        normalizeMicDeviceId(msg.micDeviceId),
        normalizeMicPermissionState((msg as MicPreflightMessage).permissionState),
      ),
    )
    .on(RuntimeMessageType.OFFSCREEN_RELEASE_PREFLIGHT_MIC, () => {
      session.releasePreflightMicStream();
      return { ok: true };
    })
    .on(RuntimeMessageType.OFFSCREEN_FORCE_CLEANUP, () => session.forceCleanupCapture())
    .on(RuntimeMessageType.OFFSCREEN_PAUSE, () => session.pauseRecording())
    .on(RuntimeMessageType.OFFSCREEN_RESUME, () => session.resumeRecording())
    .on(RuntimeMessageType.OFFSCREEN_SCAN_ORPHANS, () => recovery.scanOrphanedSessions())
    .on(RuntimeMessageType.OFFSCREEN_TEST_SEED_ORPHANS, (msg) => {
      const sessions = Array.isArray(msg.sessions)
        ? msg.sessions
            .map((s: unknown) => normalizeTestOrphanFixtureSession(s))
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
      ...session.getStatus(),
      hasOutput: Boolean(processor.outputUrl),
    }))
    .on(RuntimeMessageType.WEBCODECS_CHECK_SUPPORT, (msg) =>
      session.handleCheckWebCodecsSupport(msg.quality),
    )
    .on(RuntimeMessageType.OFFSCREEN_START_WEBCODECS, (msg) => session.handleStartWebCodecs(msg))
    .on(RuntimeMessageType.OFFSCREEN_STOP_WEBCODECS, () => session.handleStopWebCodecs());

  chrome.runtime.onMessage.addListener(router.dispatch);
});
