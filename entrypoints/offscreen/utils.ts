import type { CaptureQuality } from '@/lib/messages';

export interface CaptureProfile {
  maxWidth: number;
  maxHeight: number;
  maxFrameRate: number;
  videoBitsPerSecond: number;
}

const CAPTURE_PROFILES: Record<CaptureQuality, CaptureProfile> = {
  '720p': {
    maxWidth: 1280,
    maxHeight: 720,
    maxFrameRate: 30,
    videoBitsPerSecond: 2_500_000,
  },
  '1080p': {
    maxWidth: 1920,
    maxHeight: 1080,
    maxFrameRate: 30,
    videoBitsPerSecond: 4_000_000,
  },
};

export function normalizeCaptureQuality(value: unknown): CaptureQuality {
  if (value === '720p') {
    return value;
  }
  return '1080p';
}

export function getCaptureProfile(value: unknown): CaptureProfile {
  const quality = normalizeCaptureQuality(value);
  return CAPTURE_PROFILES[quality];
}

export function buildTabCaptureConstraints(streamId: string, value: unknown): MediaTrackConstraints {
  const profile = getCaptureProfile(value);
  return {
    mandatory: {
      chromeMediaSource: 'tab',
      chromeMediaSourceId: streamId,
      maxWidth: profile.maxWidth,
      maxHeight: profile.maxHeight,
      maxFrameRate: profile.maxFrameRate,
    },
  } as unknown as MediaTrackConstraints;
}
