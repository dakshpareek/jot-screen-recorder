import type { CaptureQuality, CaptureResolvedQuality } from '@/lib/messages';
import {
  getCaptureProfile as getSharedCaptureProfile,
  getRuntimeHintsFromNavigator,
  normalizeCaptureQuality as normalizeCaptureQualityShared,
  resolveCapturePreset,
  type CapturePresetResolution,
  type CaptureRuntimeHints,
} from '@/lib/capture-presets';

export interface CaptureProfile {
  maxWidth: number;
  maxHeight: number;
  maxFrameRate: number;
  videoBitsPerSecond: number;
  minVideoBitsPerSecond: number;
}

export interface ResolvedCapturePlan extends CapturePresetResolution {
  requestedPreset: CaptureQuality;
  fallbackChain: CaptureResolvedQuality[];
}

export function normalizeCaptureQuality(value: unknown): CaptureQuality {
  return normalizeCaptureQualityShared(value);
}

export function resolveCapturePlan(value: unknown, hints?: CaptureRuntimeHints): ResolvedCapturePlan {
  const requestedPreset = normalizeCaptureQuality(value);
  const runtimeHints = hints ?? getRuntimeHintsFromNavigator();
  return resolveCapturePreset(requestedPreset, runtimeHints);
}

export function getCaptureProfileByPreset(value: CaptureResolvedQuality): CaptureProfile {
  const profile = getSharedCaptureProfile(value);
  return {
    maxWidth: profile.width,
    maxHeight: profile.height,
    maxFrameRate: profile.fps,
    videoBitsPerSecond: profile.bitrateBps,
    minVideoBitsPerSecond: profile.minBitrateBps,
  };
}

export function getCaptureProfile(value: unknown): CaptureProfile {
  const plan = resolveCapturePlan(value);
  return getCaptureProfileByPreset(plan.fallbackChain[0]);
}

export function buildTabCaptureConstraints(
  streamId: string,
  value: CaptureResolvedQuality,
): MediaTrackConstraints {
  const profile = getCaptureProfileByPreset(value);
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
