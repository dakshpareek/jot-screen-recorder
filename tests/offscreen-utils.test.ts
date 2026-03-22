import { describe, expect, it } from 'vitest';
import {
  buildTabCaptureConstraints,
  getCaptureProfile,
  getCaptureProfileByPreset,
  normalizeCaptureQuality,
  resolveCapturePlan,
} from '@/entrypoints/offscreen/utils';

describe('offscreen capture quality profiles', () => {
  it('normalizes quality with auto default and legacy migration', () => {
    expect(normalizeCaptureQuality('auto')).toBe('auto');
    expect(normalizeCaptureQuality('1080p30')).toBe('1080p30');
    expect(normalizeCaptureQuality('1080p60')).toBe('1080p60');
    expect(normalizeCaptureQuality('4k30')).toBe('4k30');
    expect(normalizeCaptureQuality('720p')).toBe('1080p30');
    expect(normalizeCaptureQuality('legacy')).toBe('auto');
    expect(normalizeCaptureQuality(undefined)).toBe('auto');
  });

  it('resolves 4k preset with deterministic fallback chain', () => {
    const plan = resolveCapturePlan('4k30', {
      maxWidth: 2560,
      maxHeight: 1440,
    });

    expect(plan.requestedPreset).toBe('4k30');
    expect(plan.fallbackChain).toEqual(['1440p30', '1080p30']);
  });

  it('chooses stable auto preset from runtime hints', () => {
    const highEnd = resolveCapturePlan('auto', {
      maxWidth: 3840,
      maxHeight: 2160,
      deviceMemoryGB: 16,
      hardwareConcurrency: 12,
    });
    expect(highEnd.autoSelectedPreset).toBe('4k30');
    expect(highEnd.fallbackChain[0]).toBe('4k30');

    const midRange = resolveCapturePlan('auto', {
      maxWidth: 1920,
      maxHeight: 1080,
      deviceMemoryGB: 8,
      hardwareConcurrency: 8,
    });
    expect(midRange.autoSelectedPreset).toBe('1080p60');

    const lowEnd = resolveCapturePlan('auto', {
      maxWidth: 1366,
      maxHeight: 768,
      deviceMemoryGB: 4,
      hardwareConcurrency: 4,
    });
    expect(lowEnd.autoSelectedPreset).toBe('1080p30');
  });

  it('maps presets to capture constraints and bitrate targets', () => {
    const profile = getCaptureProfileByPreset('1080p60');
    expect(profile).toEqual({
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 60,
      videoBitsPerSecond: 7_000_000,
      minVideoBitsPerSecond: 1_800_000,
    });

    const defaultProfile = getCaptureProfile('unexpected');
    expect(defaultProfile.maxWidth).toBe(1920);
    expect(defaultProfile.maxFrameRate).toBeGreaterThanOrEqual(30);

    const constraints = buildTabCaptureConstraints('stream-1080-60', '1080p60') as {
      mandatory?: Record<string, unknown>;
    };
    expect(constraints.mandatory).toMatchObject({
      chromeMediaSource: 'tab',
      chromeMediaSourceId: 'stream-1080-60',
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 60,
    });
  });

  it('maps 4k preset to full constraints and bitrate', () => {
    const profile = getCaptureProfileByPreset('4k30');
    expect(profile).toEqual({
      maxWidth: 3840,
      maxHeight: 2160,
      maxFrameRate: 30,
      videoBitsPerSecond: 14_000_000,
      minVideoBitsPerSecond: 4_000_000,
    });

    const constraints = buildTabCaptureConstraints('stream-4k', '4k30') as {
      mandatory?: Record<string, unknown>;
    };
    expect(constraints.mandatory).toMatchObject({
      chromeMediaSource: 'tab',
      chromeMediaSourceId: 'stream-4k',
      maxWidth: 3840,
      maxHeight: 2160,
      maxFrameRate: 30,
    });
  });
});
