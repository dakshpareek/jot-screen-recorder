import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTURE_QUALITY,
  DEFAULT_RESOLVED_CAPTURE_QUALITY,
  getCaptureProfile,
  normalizeCaptureQuality,
  normalizeResolvedCaptureQuality,
  resolveAutoPreset,
  resolveCapturePreset,
  toCaptureQualityLabel,
  toResolvedQualityLabel,
} from '@/lib/capture-presets';

describe('capture preset resolution', () => {
  it('normalizes capture presets and resolved presets safely', () => {
    expect(DEFAULT_CAPTURE_QUALITY).toBe('auto');
    expect(DEFAULT_RESOLVED_CAPTURE_QUALITY).toBe('1080p30');
    expect(normalizeCaptureQuality('4k30')).toBe('4k30');
    expect(normalizeCaptureQuality('1080p')).toBe('1080p30');
    expect(normalizeCaptureQuality('unexpected')).toBe('auto');
    expect(normalizeResolvedCaptureQuality('1440p30')).toBe('1440p30');
    expect(normalizeResolvedCaptureQuality('unexpected')).toBe('1080p30');
  });

  it('applies orientation-safe bounds when filtering fallback chains', () => {
    const portrait = resolveCapturePreset('4k30', {
      maxWidth: 1080,
      maxHeight: 1920,
    });

    expect(portrait.requestedPreset).toBe('4k30');
    expect(portrait.autoSelectedPreset).toBe('4k30');
    expect(portrait.fallbackChain).toEqual(['1080p30']);
  });

  it('returns deterministic floor fallback when no profile fits runtime bounds', () => {
    const constrained = resolveCapturePreset('1080p60', {
      maxWidth: 1280,
      maxHeight: 720,
    });

    expect(constrained.fallbackChain).toEqual(['1080p30']);
  });

  it('chooses auto preset using capability and guardrail thresholds', () => {
    expect(
      resolveAutoPreset({
        maxWidth: 3840,
        maxHeight: 2160,
        deviceMemoryGB: 12,
        hardwareConcurrency: 12,
      }),
    ).toBe('4k30');

    expect(
      resolveAutoPreset({
        maxWidth: 1920,
        maxHeight: 1080,
        deviceMemoryGB: 6,
        hardwareConcurrency: 8,
      }),
    ).toBe('1080p60');

    expect(
      resolveAutoPreset({
        maxWidth: 3840,
        maxHeight: 2160,
        deviceMemoryGB: 16,
        hardwareConcurrency: 4,
      }),
    ).toBe('1080p30');
  });

  it('maps presets and resolved variants to stable UI labels and profiles', () => {
    expect(toCaptureQualityLabel('auto')).toBe('Auto');
    expect(toCaptureQualityLabel('1080p60')).toBe('1080p • 60fps');
    expect(toCaptureQualityLabel('4k30')).toBe('4K • 30fps');
    expect(toResolvedQualityLabel('1440p30')).toBe('1440p • 30fps');
    expect(getCaptureProfile('4k30')).toMatchObject({
      width: 3840,
      height: 2160,
      fps: 30,
    });
  });
});
