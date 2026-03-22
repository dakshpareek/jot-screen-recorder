import type { CaptureQuality } from '@/lib/messages';
import {
  VIDEO_ENCODER_PROFILES,
  AUDIO_ENCODER_CONFIG,
  OPUS_ENCODER_CONFIG,
  type ResolvedWebCodecsFormat,
  type WebCodecsAudioConfig,
} from './types';

const FALLBACK_CODECS = [
  'avc1.4d0028',
  'avc1.4d0020',
  'avc1.420028',
  'avc1.420020',
  'avc1.64001f',
  'avc1.640028',
  'vp09.00.10.08',
  'vp8',
] as const;

export function isWebMVideoCodecString(codec: string): boolean {
  const c = codec.toLowerCase();
  return c === 'vp8' || c.startsWith('vp09') || c.startsWith('vp08');
}

export function matroskaVideoCodecId(webCodec: string): 'V_VP8' | 'V_VP9' {
  const c = webCodec.toLowerCase();
  return c === 'vp8' ? 'V_VP8' : 'V_VP9';
}

async function isVideoCodecSupported(
  codec: string,
  profile: (typeof VIDEO_ENCODER_PROFILES)[CaptureQuality],
  preferHardware: boolean,
): Promise<boolean> {
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec,
      width: profile.width,
      height: profile.height,
      bitrate: profile.bitrate,
      framerate: profile.framerate,
      hardwareAcceleration: preferHardware ? 'prefer-hardware' : 'prefer-software',
      latencyMode: profile.latencyMode,
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

async function pickVideoCodecWithAudio(
  profile: (typeof VIDEO_ENCODER_PROFILES)[CaptureQuality],
): Promise<{ codec: string; useHardware: boolean } | null> {
  const codecsToTry = [profile.codec, ...FALLBACK_CODECS.filter((c) => c !== profile.codec)];

  for (const codec of codecsToTry) {
    let useHardware = false;
    let videoOk = false;
    if (await isVideoCodecSupported(codec, profile, true)) {
      useHardware = true;
      videoOk = true;
    } else if (await isVideoCodecSupported(codec, profile, false)) {
      useHardware = false;
      videoOk = true;
    }
    if (!videoOk) continue;

    const container: 'mp4' | 'webm' = isWebMVideoCodecString(codec) ? 'webm' : 'mp4';
    const audioEncoderConfig = container === 'webm' ? OPUS_ENCODER_CONFIG : AUDIO_ENCODER_CONFIG;
    if (!(await isAudioSupported(audioEncoderConfig))) {
      continue;
    }

    return { codec, useHardware };
  }

  return null;
}

async function isAudioSupported(config: WebCodecsAudioConfig): Promise<boolean> {
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: config.codec,
      sampleRate: config.sampleRate,
      numberOfChannels: config.numberOfChannels,
      bitrate: config.bitrate,
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

export async function resolveWebCodecsRecordingFormat(
  quality: CaptureQuality,
): Promise<ResolvedWebCodecsFormat> {
  const profile = VIDEO_ENCODER_PROFILES[quality];

  const base: ResolvedWebCodecsFormat = {
    videoSupported: false,
    audioSupported: false,
    hardwareAcceleration: false,
    fallbackReason: null,
    selectedVideoCodec: null,
    container: 'mp4',
    outputMimeType: 'video/mp4',
    opfsStreamFile: 'webcodecs-stream.mp4',
    audioEncoderConfig: AUDIO_ENCODER_CONFIG,
  };

  const picked = await pickVideoCodecWithAudio(profile);
  if (!picked) {
    base.fallbackReason = 'No supported video and audio codec pair found';
    return base;
  }

  const container: 'mp4' | 'webm' = isWebMVideoCodecString(picked.codec) ? 'webm' : 'mp4';
  const audioEncoderConfig = container === 'webm' ? OPUS_ENCODER_CONFIG : AUDIO_ENCODER_CONFIG;

  base.videoSupported = true;
  base.audioSupported = true;
  base.hardwareAcceleration = picked.useHardware;
  base.selectedVideoCodec = picked.codec;
  base.container = container;
  base.audioEncoderConfig = audioEncoderConfig;
  base.outputMimeType = container === 'webm' ? 'video/webm' : 'video/mp4';
  base.opfsStreamFile = container === 'webm' ? 'webcodecs-stream.webm' : 'webcodecs-stream.mp4';

  if (!picked.useHardware && container === 'mp4') {
    base.fallbackReason = 'Using software encoder';
  } else if (!picked.useHardware && container === 'webm') {
    base.fallbackReason = 'Using software encoder (WebM)';
  }

  return base;
}
