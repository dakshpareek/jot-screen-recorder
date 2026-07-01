import type { ValidationResult } from '@/lib/recording';
import {
  OffscreenEventType,
  RuntimeMessageType,
  type AudioSource,
  type CaptureQuality,
  type CaptureResolvedQuality,
  type TestPermissionState,
} from '@/lib/messages';
import { debugWarn } from '@/lib/runtime-log';
import {
  getRuntimeHintsFromNavigator,
  resolveCapturePreset,
} from '@/lib/capture-presets';
import { classifyMicPermissionRequestError } from '@/lib/testing/mic-permission';
import { isTestCaptureStreamId } from '@/lib/testing/capture-stream';
import {
  buildDownloadFileName,
  normalizeAudioSource,
  normalizeMicDeviceId,
  toErrorMessage,
} from '../background/utils';
import { buildCaptureFallbackReason, formatPresetShortLabel } from './media/capture-fallback';
import { hasMp4FtypHeader, hasWebmEbmlHeader } from './media/container-probe';
import {
  buildTabCaptureConstraints,
  getCaptureProfileByPreset,
  normalizeCaptureQuality,
  resolveCapturePlan,
} from './utils';
import {
  resolveWebCodecsRecordingFormat,
  WebCodecsPipeline,
  type WebCodecsPipelineOptions,
} from './webcodecs';
import type { OpfsBridge } from './storage/opfs-bridge';
import type { SessionManifest } from './types';

const CHUNK_DURATION_SECONDS = 10;
const CHUNK_INTERVAL_MS = CHUNK_DURATION_SECONDS * 1000;
const PREFLIGHT_MIC_HOLD_MS = 60_000;

export interface CaptureSessionDeps {
  opfs: Pick<OpfsBridge, 'writeChunk' | 'writeManifest' | 'writeWebCodecsRange'>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(): AudioContext;
  createMediaRecorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  isMimeTypeSupported(mimeType: string): boolean;
  estimateStorage(): Promise<StorageEstimate>;
  createMediaStream(tracks?: MediaStreamTrack[]): MediaStream;
  createWebCodecsPipeline(options: WebCodecsPipelineOptions): WebCodecsPipeline;
  createSyntheticStream(): { stream: MediaStream; cleanup(): void };
  sendRuntimeMessage(payload: Record<string, unknown>): Promise<unknown>;
  resolveMicPermissionState(): Promise<PermissionState | null>;
  adoptOutput(blob: Blob): string;
  sha256(data: ArrayBuffer): Promise<string>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  probeVideoDuration(blob: Blob): Promise<number>;
  now(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number | null | undefined): void;
  setInterval(callback: () => void, ms: number): number;
  clearInterval(id: number | null | undefined): void;
}

function normalizeMicPermissionState(
  value: unknown,
): TestPermissionState | PermissionState | null {
  if (value === 'unset' || value === 'prompt' || value === 'granted' || value === 'denied') {
    return value;
  }
  return null;
}

export class CaptureSession {
  // Recorder / streams
  private recorder: MediaRecorder | null = null;
  private captureStream: MediaStream | null = null;
  private tabCaptureStream: MediaStream | null = null;
  private syntheticStreamCleanup: (() => void) | null = null;
  private micCaptureStream: MediaStream | null = null;
  private preflightMicStream: MediaStream | null = null;
  private preflightMicHoldTimer: number | null = null;

  // Session metadata
  private activeSessionId: string | null = null;
  private manifest: SessionManifest | null = null;
  private activeCaptureQuality: CaptureQuality = 'auto';
  private activeResolvedPreset: CaptureResolvedQuality = '1080p30';
  private chunkCount = 0;

  // WebCodecs state
  private webcodecsStreamHighWater = 0;
  private webcodecsManifestTimer: number | null = null;
  private webcodecsPipeline: WebCodecsPipeline | null = null;
  private webcodecsPipelineStartTime: number | null = null;

  // Stop-flush barrier
  private pendingStop = false;
  private stopFinalDataPromise: Promise<void> | null = null;
  private resolveStopFinalData: (() => void) | null = null;
  private stopFinalDataTimeout: number | null = null;
  private stopCompletionPromise: Promise<void> | null = null;
  private resolveStopCompletion: (() => void) | null = null;

  // Write queue
  private writeQueue: Promise<void> = Promise.resolve();
  private writeError: Error | null = null;

  // System-audio check
  private systemAudioCheckTimer: number | null = null;
  private systemAudioAudioCtx: AudioContext | null = null;
  private systemAudioSource: MediaStreamAudioSourceNode | null = null;

  // Audio mix nodes
  private mixAudioCtx: AudioContext | null = null;
  private mixTabSource: MediaStreamAudioSourceNode | null = null;
  private mixMicSource: MediaStreamAudioSourceNode | null = null;
  private mixTabGain: GainNode | null = null;
  private mixMicGain: GainNode | null = null;
  private mixDestination: MediaStreamAudioDestinationNode | null = null;

  // Storage monitor
  private storageMonitorInterval: number | null = null;

  constructor(private readonly deps: CaptureSessionDeps) {}

  // ─── Public API (called by router handlers) ────────────────────────────────

  getStatus() {
    return {
      alive: true,
      isRecording: this.recorder?.state === 'recording',
      isWebCodecsRecording: this.webcodecsPipeline?.isRunning() ?? false,
      chunkCount: this.chunkCount,
      sessionId: this.activeSessionId,
    };
  }

  async handleCheckWebCodecsSupport(quality: unknown) {
    try {
      return await this.checkWebCodecsSupport(normalizeCaptureQuality(quality));
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

  async handleStartWebCodecs(msg: {
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

      const tabStreamResolution = await this.getTabStreamByIdWithFallback(streamId, quality);
      this.tabCaptureStream = tabStreamResolution.stream;

      const stream = await this.buildCaptureStream(
        this.tabCaptureStream,
        audioSource,
        micDeviceId,
      );
      this.captureStream = stream;

      const result = await this.startWebCodecsRecording(
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
        await this.cleanupMedia();
      }

      return result;
    } catch (error) {
      console.error('[Offscreen] WebCodecs start error:', error);
      await this.cleanupMedia();
      return { ok: false, error: this.toNamedErrorMessage(error) };
    }
  }

  async handleStopWebCodecs() {
    try {
      const result = await this.stopWebCodecsRecording();
      await this.cleanupMedia();
      return result;
    } catch (error) {
      this.cleanupWebCodecsPipeline();
      await this.cleanupMedia().catch(() => {});
      return { ok: false, error: this.toNamedErrorMessage(error) };
    }
  }

  async startRecording(
    nextSessionId: string,
    streamId: string,
    audioSource: AudioSource,
    micDeviceId: string | null,
    captureQuality: CaptureQuality,
    exportBaseName = '',
    recordingStartTime?: number,
  ) {
    if (this.recorder?.state === 'recording') {
      return { ok: false, error: 'Recorder is already active' };
    }

    if (!streamId) {
      return { ok: false, error: 'Missing tab stream id' };
    }

    try {
      const streamResolution = await this.getTabStreamByIdWithFallback(streamId, captureQuality);
      this.activeCaptureQuality = streamResolution.requestedPreset;
      this.activeResolvedPreset = streamResolution.resolvedPreset;
      const captureProfile = getCaptureProfileByPreset(this.activeResolvedPreset);
      this.tabCaptureStream = streamResolution.stream;
      this.captureStream = await this.buildCaptureStream(
        this.tabCaptureStream,
        audioSource,
        micDeviceId,
      );

      this.activeSessionId = nextSessionId;
      this.chunkCount = 0;
      this.pendingStop = false;
      this.writeError = null;
      this.writeQueue = Promise.resolve();

      this.manifest = {
        sessionId: nextSessionId,
        exportBaseName: exportBaseName || undefined,
        startTime: recordingStartTime ?? this.deps.now(),
        recordingQuality: this.activeCaptureQuality,
        recordingResolvedQuality: this.activeResolvedPreset,
        chunks: [],
        totalDuration: 0,
        status: 'recording',
      };

      const mimeType = this.pickMimeType();
      this.recorder = this.deps.createMediaRecorder(this.captureStream, {
        mimeType,
        videoBitsPerSecond: captureProfile.videoBitsPerSecond,
      });
      if (this.manifest) {
        this.manifest.mimeType = this.recorder.mimeType || mimeType;
      }
      await this.writeManifest();

      this.recorder.ondataavailable = (event) => {
        if (event.data.size <= 0) return;
        const nextIndex = this.chunkCount;
        this.chunkCount += 1;
        this.enqueueChunkWrite(nextIndex, event.data);
        if (this.pendingStop) {
          this.resolveFinalStopData();
        }
      };

      this.recorder.onstop = () => {
        void this.finalizeStop();
      };

      this.recorder.onerror = (event) => {
        const eventWithError = event as Event & { error?: { message?: string } };
        const err = eventWithError.error?.message ?? 'MediaRecorder error';
        void this.emitEvent(OffscreenEventType.ERROR, { error: err });
      };

      this.recorder.start(CHUNK_INTERVAL_MS);
      this.startSystemAudioCheck(this.tabCaptureStream);
      this.startStorageMonitor();

      return {
        ok: true,
        outputMimeType: this.recorder.mimeType || mimeType,
        fileName: buildDownloadFileName(
          this.manifest.exportBaseName ?? nextSessionId,
          this.recorder.mimeType || mimeType,
        ),
        requestedPreset: this.activeCaptureQuality,
        resolvedPreset: this.activeResolvedPreset,
        fallbackReason: streamResolution.fallbackReason,
      };
    } catch (error) {
      console.error('[Offscreen] startRecording failed:', this.toNamedErrorMessage(error));
      await this.cleanupMedia();
      return { ok: false, error: this.toNamedErrorMessage(error) };
    }
  }

  async stopRecording() {
    if (!this.recorder || this.recorder.state === 'inactive') {
      return { ok: false, error: 'Recorder is not active' };
    }

    if (this.pendingStop) {
      if (this.stopCompletionPromise) {
        await this.stopCompletionPromise;
      }
      return { ok: true };
    }

    this.pendingStop = true;
    this.stopFinalDataPromise = new Promise<void>((resolve) => {
      this.resolveStopFinalData = resolve;
    });
    this.stopFinalDataTimeout = this.deps.setTimeout(() => {
      this.resolveFinalStopData();
    }, 1_500);
    this.stopCompletionPromise = new Promise<void>((resolve) => {
      this.resolveStopCompletion = resolve;
    });
    this.stopSystemAudioCheck();
    this.stopStorageMonitor();
    if (this.manifest) {
      this.manifest.status = 'stopping';
      this.writeQueue = this.writeQueue.then(async () => {
        await this.writeManifest();
      });
    }

    try {
      this.recorder.stop();
    } catch (error) {
      this.resolveStopCompletion?.();
      this.resolveStopCompletion = null;
      this.stopCompletionPromise = null;
      return { ok: false, error: toErrorMessage(error) };
    }

    await this.stopCompletionPromise;
    return { ok: true };
  }

  async pauseRecording() {
    if (!this.recorder || this.recorder.state !== 'recording') {
      return { ok: false, error: 'Recorder is not actively recording' };
    }
    try {
      this.recorder.pause();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  async resumeRecording() {
    if (!this.recorder || this.recorder.state !== 'paused') {
      return { ok: false, error: 'Recorder is not paused' };
    }
    try {
      this.recorder.resume();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  async forceCleanupCapture() {
    try {
      this.pendingStop = false;
      this.clearFinalStopDataWait();
      this.resolveStopCompletion?.();
      this.resolveStopCompletion = null;
      this.stopCompletionPromise = null;

      if (this.webcodecsPipeline) {
        this.cleanupWebCodecsPipeline();
      }

      await this.cleanupMedia();
      this.activeSessionId = null;
      return { ok: true };
    } catch (error) {
      this.cleanupWebCodecsPipeline();
      await this.cleanupMedia().catch(() => {});
      return { ok: false, error: this.toNamedErrorMessage(error) };
    }
  }

  async runMicPreflight(
    micDeviceId: string | null = null,
    permissionState: TestPermissionState | PermissionState | null = null,
  ) {
    this.releasePreflightMicStream();
    try {
      const resolvedPermissionState =
        permissionState ?? (await this.deps.resolveMicPermissionState());
      if (resolvedPermissionState === 'denied') {
        return { ok: false, error: 'MIC_PERMISSION_DENIED' };
      }
      if (resolvedPermissionState === 'prompt') {
        return { ok: false, error: 'MIC_PERMISSION_PROMPT' };
      }
    } catch {
      // Some Chrome contexts may not expose permission query reliably.
    }

    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    try {
      stream = await this.requestMicStream(micDeviceId);

      audioCtx = this.deps.createAudioContext();
      const analyser = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      await this.wait(1_000);
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      const level = data.reduce((sum, value) => sum + value, 0) / data.length;
      const deviceLabel = stream.getAudioTracks()[0]?.label ?? null;

      source.disconnect();
      this.preflightMicStream = stream;
      stream = null;
      this.schedulePreflightMicHoldRelease();
      return { ok: true, level, deviceLabel };
    } catch (error) {
      const classified = classifyMicPermissionRequestError(error);
      if (classified) {
        return { ok: false, error: classified };
      }
      return { ok: false, error: this.toNamedErrorMessage(error) };
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      await audioCtx?.close().catch(() => {});
    }
  }

  releasePreflightMicStream() {
    this.clearPreflightMicHoldRelease();
    if (!this.preflightMicStream) return;
    this.preflightMicStream.getTracks().forEach((track) => track.stop());
    this.preflightMicStream = null;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async getTabStreamByIdWithFallback(streamId: string, captureQuality: CaptureQuality) {
    const plan = resolveCapturePlan(captureQuality, getRuntimeHintsFromNavigator());
    const attemptErrors: string[] = [];

    for (const preset of plan.fallbackChain) {
      try {
        const stream = await this.getTabStreamByPreset(streamId, preset);
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
        attemptErrors.push(`${preset}: ${this.toNamedErrorMessage(error)}`);
      }
    }

    throw new Error(
      `Unable to start tab capture for "${plan.requestedPreset}" (${attemptErrors.join(' | ')})`,
    );
  }

  private async getTabStreamByPreset(streamId: string, resolvedPreset: CaptureResolvedQuality) {
    if (isTestCaptureStreamId(streamId)) {
      const { stream, cleanup } = this.deps.createSyntheticStream();
      this.syntheticStreamCleanup = cleanup;
      return stream;
    }

    const video = buildTabCaptureConstraints(streamId, resolvedPreset);
    const audio = {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as unknown as MediaTrackConstraints;

    return await this.deps.getUserMedia({ video, audio });
  }

  private async requestMicStream(micDeviceId: string | null = null) {
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (micDeviceId) {
      audioConstraints.deviceId = { exact: micDeviceId };
    }

    return await this.deps.getUserMedia({
      audio: audioConstraints,
      video: false,
    });
  }

  private consumePreflightMicStream() {
    if (!this.preflightMicStream) return null;
    this.clearPreflightMicHoldRelease();
    const stream = this.preflightMicStream;
    this.preflightMicStream = null;
    return stream;
  }

  private clearPreflightMicHoldRelease() {
    if (!this.preflightMicHoldTimer) return;
    this.deps.clearTimeout(this.preflightMicHoldTimer);
    this.preflightMicHoldTimer = null;
  }

  private schedulePreflightMicHoldRelease() {
    this.clearPreflightMicHoldRelease();
    this.preflightMicHoldTimer = this.deps.setTimeout(() => {
      this.releasePreflightMicStream();
    }, PREFLIGHT_MIC_HOLD_MS);
  }

  private async buildCaptureStream(
    tabStream: MediaStream,
    audioSource: AudioSource,
    micDeviceId: string | null,
  ) {
    const videoTracks = tabStream.getVideoTracks();
    if (!videoTracks.length) {
      throw new Error('Tab capture did not provide a video track');
    }

    if (audioSource === 'silent') {
      this.releasePreflightMicStream();
      return this.deps.createMediaStream([...videoTracks]);
    }

    if (audioSource === 'tab') {
      this.releasePreflightMicStream();
      return this.deps.createMediaStream([...videoTracks, ...tabStream.getAudioTracks()]);
    }

    if (audioSource === 'mic') {
      this.micCaptureStream =
        this.consumePreflightMicStream() ?? (await this.requestMicStream(micDeviceId));
      const micTracks = this.micCaptureStream.getAudioTracks();
      if (!micTracks.length) {
        throw new Error('Microphone capture did not provide an audio track');
      }
      return this.deps.createMediaStream([...videoTracks, ...micTracks]);
    }

    try {
      this.micCaptureStream =
        this.consumePreflightMicStream() ?? (await this.requestMicStream(micDeviceId));
      const micTracks = this.micCaptureStream.getAudioTracks();
      if (!micTracks.length) {
        throw new Error('Microphone capture did not provide an audio track');
      }

      this.mixAudioCtx = this.deps.createAudioContext();
      this.mixDestination = this.mixAudioCtx.createMediaStreamDestination();

      const tabAudioTracks = tabStream.getAudioTracks();
      if (tabAudioTracks.length) {
        this.mixTabSource = this.mixAudioCtx.createMediaStreamSource(
          this.deps.createMediaStream(tabAudioTracks),
        );
        this.mixTabGain = this.mixAudioCtx.createGain();
        this.mixTabGain.gain.value = 1;
        this.mixTabSource.connect(this.mixTabGain);
        this.mixTabGain.connect(this.mixDestination);
      }

      this.mixMicSource = this.mixAudioCtx.createMediaStreamSource(
        this.deps.createMediaStream(micTracks),
      );
      this.mixMicGain = this.mixAudioCtx.createGain();
      this.mixMicGain.gain.value = 1.4;
      this.mixMicSource.connect(this.mixMicGain);
      this.mixMicGain.connect(this.mixDestination);
      await this.mixAudioCtx.resume().catch(() => {});

      const mixedAudioTracks = this.mixDestination.stream.getAudioTracks();
      if (!mixedAudioTracks.length) {
        throw new Error('Failed to build mixed audio stream');
      }

      return this.deps.createMediaStream([...videoTracks, ...mixedAudioTracks]);
    } catch (error) {
      const currentMicStream: MediaStream | null = this.micCaptureStream;
      const liveMicTracks: MediaStreamTrack[] = currentMicStream
        ? currentMicStream
            .getAudioTracks()
            .filter((track: MediaStreamTrack) => track.readyState === 'live')
        : [];

      if (this.mixTabSource) {
        try {
          this.mixTabSource.disconnect();
        } catch {}
        this.mixTabSource = null;
      }
      if (this.mixMicSource) {
        try {
          this.mixMicSource.disconnect();
        } catch {}
        this.mixMicSource = null;
      }
      if (this.mixTabGain) {
        try {
          this.mixTabGain.disconnect();
        } catch {}
        this.mixTabGain = null;
      }
      if (this.mixMicGain) {
        try {
          this.mixMicGain.disconnect();
        } catch {}
        this.mixMicGain = null;
      }
      this.mixDestination = null;
      if (this.mixAudioCtx) {
        await this.mixAudioCtx.close().catch(() => {});
        this.mixAudioCtx = null;
      }

      await this.emitRuntimeSignal({
        type: RuntimeMessageType.MIC_MIX_FAILED,
        reason: this.toNamedErrorMessage(error),
        fallback: liveMicTracks.length > 0 ? 'mic_only' : 'tab_only',
      });

      if (liveMicTracks.length > 0) {
        return this.deps.createMediaStream([...videoTracks, ...liveMicTracks]);
      }

      if (currentMicStream) {
        currentMicStream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
        this.micCaptureStream = null;
      }

      return this.deps.createMediaStream([...videoTracks, ...tabStream.getAudioTracks()]);
    }
  }

  private pickMimeType() {
    const preferred = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
      'video/mp4;codecs=avc1.4D401E',
      'video/mp4',
    ];

    for (const mimeType of preferred) {
      if (this.deps.isMimeTypeSupported(mimeType)) {
        return mimeType;
      }
    }

    return '';
  }

  private enqueueChunkWrite(index: number, blob: Blob) {
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.writeError) return;

      try {
        if (!this.activeSessionId || !this.manifest) {
          throw new Error('Recording session is not initialized');
        }

        const arrayBuffer = await blob.arrayBuffer();
        const checksum = await this.deps.sha256(arrayBuffer);

        await this.deps.opfs.writeChunk(this.activeSessionId, index, arrayBuffer);

        this.manifest.chunks.push({
          index,
          size: blob.size,
          written: true,
          duration: CHUNK_DURATION_SECONDS,
          checksum,
        });
        this.manifest.totalDuration = this.manifest.chunks.length * CHUNK_DURATION_SECONDS;
        this.manifest.status = this.pendingStop ? 'stopping' : 'recording';
        await this.writeManifest();

        await this.emitEvent(OffscreenEventType.CHUNK_WRITTEN, { chunkCount: this.chunkCount });
      } catch (error) {
        this.writeError = error instanceof Error ? error : new Error(toErrorMessage(error));
        await this.emitEvent(OffscreenEventType.ERROR, {
          error: `Chunk write failed: ${toErrorMessage(error)}`,
        });
      }
    });
  }

  private async writeManifest() {
    if (!this.activeSessionId || !this.manifest) {
      throw new Error('Manifest write called without active session');
    }
    await this.deps.opfs.writeManifest(this.activeSessionId, this.manifest);
  }

  private async finalizeStop() {
    try {
      if (this.stopFinalDataPromise) {
        await this.stopFinalDataPromise;
      }
      await this.writeQueue;
      if (this.writeError) throw this.writeError;

      if (this.manifest) {
        this.manifest.status = 'complete';
        this.manifest.totalDuration = this.manifest.chunks.length * CHUNK_DURATION_SECONDS;
        await this.writeManifest();
      }

      await this.emitEvent(OffscreenEventType.FINAL_CHUNK_WRITTEN, {
        sessionId: this.activeSessionId,
        chunkCount: this.chunkCount,
      });
    } catch (error) {
      await this.emitEvent(OffscreenEventType.ERROR, {
        error: `Finalization failed: ${toErrorMessage(error)}`,
      });
    } finally {
      await this.cleanupMedia();
      this.clearFinalStopDataWait();
      this.pendingStop = false;
      this.resolveStopCompletion?.();
      this.resolveStopCompletion = null;
      this.stopCompletionPromise = null;
    }
  }

  private resolveFinalStopData() {
    if (!this.resolveStopFinalData) return;
    this.resolveStopFinalData();
    this.resolveStopFinalData = null;
    this.clearFinalStopDataTimeout();
  }

  private clearFinalStopDataTimeout() {
    if (!this.stopFinalDataTimeout) return;
    this.deps.clearTimeout(this.stopFinalDataTimeout);
    this.stopFinalDataTimeout = null;
  }

  private clearFinalStopDataWait() {
    this.clearFinalStopDataTimeout();
    this.resolveStopFinalData = null;
    this.stopFinalDataPromise = null;
  }

  private async cleanupMedia() {
    this.stopSystemAudioCheck();
    this.stopStorageMonitor();
    this.releasePreflightMicStream();

    if (this.syntheticStreamCleanup) {
      this.syntheticStreamCleanup();
      this.syntheticStreamCleanup = null;
    }

    if (this.mixTabSource) {
      try {
        this.mixTabSource.disconnect();
      } catch {}
      this.mixTabSource = null;
    }
    if (this.mixMicSource) {
      try {
        this.mixMicSource.disconnect();
      } catch {}
      this.mixMicSource = null;
    }
    if (this.mixTabGain) {
      try {
        this.mixTabGain.disconnect();
      } catch {}
      this.mixTabGain = null;
    }
    if (this.mixMicGain) {
      try {
        this.mixMicGain.disconnect();
      } catch {}
      this.mixMicGain = null;
    }
    this.mixDestination = null;
    if (this.mixAudioCtx) {
      await this.mixAudioCtx.close().catch(() => {});
      this.mixAudioCtx = null;
    }

    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      try {
        if (this.recorder.state !== 'inactive') {
          this.recorder.stop();
        }
      } catch {}
    }

    if (this.captureStream) {
      this.captureStream.getTracks().forEach((track) => track.stop());
    }
    if (this.tabCaptureStream) {
      this.tabCaptureStream.getTracks().forEach((track) => track.stop());
    }
    if (this.micCaptureStream) {
      this.micCaptureStream.getTracks().forEach((track) => track.stop());
    }
    this.captureStream = null;
    this.tabCaptureStream = null;
    this.micCaptureStream = null;
    this.recorder = null;
  }

  private startSystemAudioCheck(stream: MediaStream) {
    this.stopSystemAudioCheck();

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      void this.emitRuntimeSignal({ type: RuntimeMessageType.SYSTEM_AUDIO_ABSENT });
      return;
    }

    try {
      const audioStream = this.deps.createMediaStream(audioTracks);
      const audioCtx = this.deps.createAudioContext();
      const analyser = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(audioStream);
      source.connect(analyser);

      this.systemAudioAudioCtx = audioCtx;
      this.systemAudioSource = source;

      this.systemAudioCheckTimer = this.deps.setTimeout(() => {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const level = data.reduce((sum, value) => sum + value, 0) / data.length;

        if (level <= 0) {
          void this.emitRuntimeSignal({ type: RuntimeMessageType.SYSTEM_AUDIO_SILENT, level });
        } else {
          void this.emitRuntimeSignal({ type: RuntimeMessageType.SYSTEM_AUDIO_OK, level });
        }

        this.stopSystemAudioCheck();
      }, 2_000);
    } catch (error) {
      void this.emitRuntimeSignal({
        type: RuntimeMessageType.SYSTEM_AUDIO_ABSENT,
        error: toErrorMessage(error),
      });
      this.stopSystemAudioCheck();
    }
  }

  private stopSystemAudioCheck() {
    if (this.systemAudioCheckTimer) {
      this.deps.clearTimeout(this.systemAudioCheckTimer);
      this.systemAudioCheckTimer = null;
    }
    if (this.systemAudioSource) {
      try {
        this.systemAudioSource.disconnect();
      } catch {}
      this.systemAudioSource = null;
    }
    if (this.systemAudioAudioCtx) {
      void this.systemAudioAudioCtx.close().catch(() => {});
      this.systemAudioAudioCtx = null;
    }
  }

  private startStorageMonitor() {
    this.stopStorageMonitor();
    this.storageMonitorInterval = this.deps.setInterval(() => {
      void (async () => {
        try {
          const estimate = await this.deps.estimateStorage();
          const availableMB = Math.max(
            0,
            ((estimate.quota ?? 0) - (estimate.usage ?? 0)) / (1024 * 1024),
          );

          if (availableMB < 50) {
            await this.emitRuntimeSignal({
              type: RuntimeMessageType.AUTO_STOP_LOW_STORAGE,
              availableMB,
            });
            this.stopStorageMonitor();
            return;
          }

          if (availableMB < 100) {
            await this.emitRuntimeSignal({
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

  private stopStorageMonitor() {
    if (this.storageMonitorInterval) {
      this.deps.clearInterval(this.storageMonitorInterval);
      this.storageMonitorInterval = null;
    }
  }

  private async emitRuntimeSignal(payload: Record<string, unknown>) {
    try {
      await this.deps.sendRuntimeMessage(payload);
    } catch {
      // Background may be asleep between events; ignore.
    }
  }

  private async emitEvent(event: string, payload: Record<string, unknown>) {
    try {
      await this.deps.sendRuntimeMessage({
        type: RuntimeMessageType.OFFSCREEN_EVENT,
        event,
        ...payload,
      });
    } catch {
      // Background may be asleep between events; ignore.
    }
  }

  private wait(ms: number) {
    return new Promise<void>((resolve) => this.deps.setTimeout(resolve, ms));
  }

  private toNamedErrorMessage(error: unknown) {
    if (error instanceof Error) {
      if (error.name && error.name !== 'Error') {
        return `${error.name}: ${error.message}`;
      }
      return error.message;
    }
    return typeof error === 'string' ? error : 'Unknown error';
  }

  // ─── WebCodecs ─────────────────────────────────────────────────────────────

  private async resolveWebCodecsFormatForPreset(
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

  private async checkWebCodecsSupport(quality: CaptureQuality) {
    try {
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

      const formatResolution = await this.resolveWebCodecsFormatForPreset(quality);
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
        fallbackReason: formatResolution.fallbackReason ?? result.fallbackReason ?? null,
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

  private async startWebCodecsRecording(
    nextSessionId: string,
    stream: MediaStream,
    requestedPreset: CaptureQuality,
    preferredResolvedPreset: CaptureResolvedQuality,
    captureFallbackReason: string | null,
    exportBaseName = '',
    recordingStartTime?: number,
  ) {
    if (this.webcodecsPipeline?.isRunning()) {
      return { ok: false, error: 'WebCodecs pipeline already running' };
    }

    try {
      const formatResolution = await this.resolveWebCodecsFormatForPreset(
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

      this.activeSessionId = nextSessionId;
      this.activeCaptureQuality = formatResolution.requestedPreset;
      this.activeResolvedPreset = formatResolution.resolvedPreset;
      this.chunkCount = 0;
      this.webcodecsStreamHighWater = 0;
      if (this.webcodecsManifestTimer) {
        this.deps.clearTimeout(this.webcodecsManifestTimer);
        this.webcodecsManifestTimer = null;
      }

      this.manifest = {
        sessionId: nextSessionId,
        exportBaseName: exportBaseName || undefined,
        startTime: recordingStartTime ?? this.deps.now(),
        recordingQuality: this.activeCaptureQuality,
        recordingResolvedQuality: this.activeResolvedPreset,
        mimeType: resolved.outputMimeType,
        chunks: [],
        totalDuration: 0,
        status: 'recording',
        recordingKind: 'webcodecs-opfs',
        streamBytesWritten: 0,
        webCodecsOpfsStreamFile: resolved.opfsStreamFile,
      };
      await this.writeManifest();

      const streamSessionId = nextSessionId;
      const opfsStreamFile = resolved.opfsStreamFile;
      const persistWrite = async (position: number, data: ArrayBuffer) => {
        await this.deps.opfs.writeWebCodecsRange(streamSessionId, position, data, opfsStreamFile);
        this.webcodecsStreamHighWater = Math.max(
          this.webcodecsStreamHighWater,
          position + data.byteLength,
        );
        this.scheduleWebcodecsManifestUpdate();
      };

      this.webcodecsPipeline = this.deps.createWebCodecsPipeline({
        requestedPreset: this.activeCaptureQuality,
        resolvedPreset: this.activeResolvedPreset,
        resolvedFormat: resolved,
        opfsPersist: {
          writeRange: persistWrite,
          readComplete: () =>
            Promise.reject(new Error('readComplete not used during active recording')),
        },
        onProgress: (stats) => {
          void this.emitEvent(OffscreenEventType.CHUNK_WRITTEN, {
            chunkCount: Math.floor(stats.framesEncoded / 300),
          });
          void this.emitEvent(OffscreenEventType.WEBCODECS_STATS, {
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
            void this.emitEvent(OffscreenEventType.ERROR, { error: error.message });
          }
          void this.emitRuntimeSignal({
            type: RuntimeMessageType.WEBCODECS_FATAL_ERROR,
            error: error.message,
          });
        },
      });

      await this.webcodecsPipeline.start(stream);
      this.webcodecsPipelineStartTime = this.deps.now();

      return {
        ok: true,
        hardwareAccelerated: resolved.hardwareAcceleration,
        outputMimeType: resolved.outputMimeType,
        fileName: buildDownloadFileName(
          this.manifest.exportBaseName ?? nextSessionId,
          resolved.outputMimeType,
        ),
        requestedPreset: this.activeCaptureQuality,
        resolvedPreset: this.activeResolvedPreset,
        fallbackReason:
          [captureFallbackReason, formatResolution.fallbackReason, resolved.fallbackReason]
            .filter((reason): reason is string => Boolean(reason))
            .join(' ') || null,
      };
    } catch (error) {
      console.error('[WebCodecs] Failed to start', error);
      this.cleanupWebCodecsPipeline();
      return { ok: false, error: this.toNamedErrorMessage(error) };
    }
  }

  private async stopWebCodecsRecording() {
    if (!this.webcodecsPipeline) {
      return { ok: false, error: 'No WebCodecs recording in progress' };
    }

    try {
      const stopStartTime = performance.now();

      const outputBuffer = await this.webcodecsPipeline.stop();
      const stopDurationMs = performance.now() - stopStartTime;
      const finalStats = this.webcodecsPipeline.getStats();

      const outMime = finalStats.outputMimeType;
      const blob = new Blob([outputBuffer], { type: outMime });
      const outputUrl = this.deps.adoptOutput(blob);

      const validation = await this.validateWebCodecsOutput(blob);

      if (this.manifest?.recordingKind === 'webcodecs-opfs') {
        if (this.webcodecsManifestTimer) {
          this.deps.clearTimeout(this.webcodecsManifestTimer);
          this.webcodecsManifestTimer = null;
        }
        this.manifest.status = 'complete';
        this.manifest.streamBytesWritten = outputBuffer.byteLength;
        await this.writeManifest();
      }

      this.cleanupWebCodecsPipeline();

      await this.emitEvent(OffscreenEventType.FINAL_CHUNK_WRITTEN, {
        sessionId: this.activeSessionId,
        chunkCount: Math.floor(finalStats.framesEncoded / 300),
      });

      return {
        ok: true,
        outputUrl,
        outputMimeType: outMime,
        fileName: buildDownloadFileName(
          this.manifest?.exportBaseName ?? this.activeSessionId,
          outMime,
        ),
        outputSize: outputBuffer.byteLength,
        stopDurationMs,
        stats: finalStats,
        validation,
      };
    } catch (error) {
      console.error('[WebCodecs] Failed to stop', error);
      this.cleanupWebCodecsPipeline();
      return { ok: false, error: this.toNamedErrorMessage(error) };
    }
  }

  private async validateWebCodecsOutput(blob: Blob): Promise<ValidationResult> {
    const checks = { size: blob.size > 1000, header: false, duration: false };

    try {
      const isWebm = blob.type.includes('webm');
      checks.header = isWebm ? await hasWebmEbmlHeader(blob) : await hasMp4FtypHeader(blob);

      const duration = await this.deps.probeVideoDuration(blob);
      checks.duration = duration > 0 && Number.isFinite(duration);
    } catch {
      // Validation checks remain false.
    }

    return { passed: checks.size && checks.header && checks.duration, checks };
  }

  private scheduleWebcodecsManifestUpdate() {
    if (this.manifest?.recordingKind !== 'webcodecs-opfs') return;
    if (this.webcodecsManifestTimer) return;
    this.webcodecsManifestTimer = this.deps.setTimeout(() => {
      this.webcodecsManifestTimer = null;
      void (async () => {
        if (
          !this.manifest ||
          this.manifest.recordingKind !== 'webcodecs-opfs' ||
          !this.activeSessionId
        )
          return;
        try {
          this.manifest.streamBytesWritten = this.webcodecsStreamHighWater;
          await this.writeManifest();
        } catch {
          // Best-effort; recording continues without blocking on manifest IO.
        }
      })();
    }, 2500);
  }

  private cleanupWebCodecsPipeline() {
    if (this.webcodecsManifestTimer) {
      this.deps.clearTimeout(this.webcodecsManifestTimer);
      this.webcodecsManifestTimer = null;
    }
    this.webcodecsPipeline = null;
    this.webcodecsPipelineStartTime = null;
  }
}
