import { describe, expect, it } from 'vitest';
import {
  buildTabCaptureConstraints,
  getCaptureProfile,
  normalizeCaptureQuality,
} from '@/entrypoints/offscreen/utils';

describe('offscreen capture quality profiles', () => {
  it('normalizes quality with 1080p fallback', () => {
    expect(normalizeCaptureQuality('720p')).toBe('720p');
    expect(normalizeCaptureQuality('1080p')).toBe('1080p');
    expect(normalizeCaptureQuality('legacy')).toBe('1080p');
    expect(normalizeCaptureQuality(undefined)).toBe('1080p');
  });

  it('maps 720p to lower constraints and bitrate', () => {
    const profile = getCaptureProfile('720p');
    expect(profile).toEqual({
      maxWidth: 1280,
      maxHeight: 720,
      maxFrameRate: 30,
      videoBitsPerSecond: 2_500_000,
    });

    const constraints = buildTabCaptureConstraints('stream-720', '720p') as {
      mandatory?: Record<string, unknown>;
    };
    expect(constraints.mandatory).toMatchObject({
      chromeMediaSource: 'tab',
      chromeMediaSourceId: 'stream-720',
      maxWidth: 1280,
      maxHeight: 720,
      maxFrameRate: 30,
    });
  });

  it('maps 1080p to full constraints and current bitrate', () => {
    const profile = getCaptureProfile('1080p');
    expect(profile).toEqual({
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 30,
      videoBitsPerSecond: 4_000_000,
    });

    const constraints = buildTabCaptureConstraints('stream-1080', '1080p') as {
      mandatory?: Record<string, unknown>;
    };
    expect(constraints.mandatory).toMatchObject({
      chromeMediaSource: 'tab',
      chromeMediaSourceId: 'stream-1080',
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 30,
    });
  });
});
