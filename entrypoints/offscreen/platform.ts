import { WebCodecsPipeline } from './webcodecs';
import type { OpfsBridge } from './storage/opfs-bridge';
import type { Processor } from './processing/processor';
import type { CaptureSessionDeps } from './capture-session';

/**
 * Wire real browser APIs into CaptureSessionDeps.
 * All browser-global accesses (getUserMedia, AudioContext, MediaRecorder, …)
 * live here so capture-session.ts stays testable behind fakes.
 */
export function createCaptureSessionDeps(
  opfsBridge: OpfsBridge,
  processor: Processor,
): CaptureSessionDeps {
  return {
    opfs: opfsBridge,

    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),

    createAudioContext: () => new AudioContext(),

    createMediaRecorder: (stream, options) => new MediaRecorder(stream, options),

    isMimeTypeSupported: (mimeType) => MediaRecorder.isTypeSupported(mimeType),

    estimateStorage: () => navigator.storage.estimate(),

    createMediaStream: (tracks) => (tracks ? new MediaStream(tracks) : new MediaStream()),

    createWebCodecsPipeline: (options) => new WebCodecsPipeline(options),

    createSyntheticStream: () => {
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
      const interval = setInterval(draw, 1000 / 30);

      return {
        stream: canvas.captureStream(30),
        cleanup: () => clearInterval(interval),
      };
    },

    sendRuntimeMessage: (payload) => chrome.runtime.sendMessage(payload),

    resolveMicPermissionState: async () => {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        return status.state;
      } catch {
        return null;
      }
    },

    adoptOutput: (blob) => processor.adoptOutput(blob),

    sha256: async (data) => {
      const digest = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    },

    createObjectURL: (blob) => URL.createObjectURL(blob),

    revokeObjectURL: (url) => URL.revokeObjectURL(url),

    probeVideoDuration: (blob) =>
      new Promise<number>((resolve) => {
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
      }),

    now: () => Date.now(),
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms) as unknown as number,
    clearTimeout: (id) => globalThis.clearTimeout(id ?? undefined),
    setInterval: (cb, ms) => globalThis.setInterval(cb, ms) as unknown as number,
    clearInterval: (id) => globalThis.clearInterval(id ?? undefined),
  };
}
