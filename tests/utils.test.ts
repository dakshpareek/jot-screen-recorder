import { describe, expect, it, vi } from 'vitest';
import {
  createSessionId,
  delay,
  getSystemAudioPreflightSnapshot,
  normalizeAudioSource,
  normalizeCaptureQuality,
  normalizeResolvedCaptureQuality,
  normalizeMicDeviceId,
  normalizeSystemAudioStatus,
  toErrorMessage,
} from '@/entrypoints/background/utils';

describe('background utils', () => {
  it('normalizes system audio status safely', () => {
    expect(normalizeSystemAudioStatus('pending')).toBe('pending');
    expect(normalizeSystemAudioStatus('ok')).toBe('ok');
    expect(normalizeSystemAudioStatus('absent')).toBe('absent');
    expect(normalizeSystemAudioStatus('silent')).toBe('silent');
    expect(normalizeSystemAudioStatus('unexpected')).toBe('idle');
    expect(normalizeSystemAudioStatus(null)).toBe('idle');
  });

  it('normalizes audio source safely', () => {
    expect(normalizeAudioSource('mic')).toBe('mic');
    expect(normalizeAudioSource('tab')).toBe('tab');
    expect(normalizeAudioSource('silent')).toBe('silent');
    expect(normalizeAudioSource('both')).toBe('both');
    expect(normalizeAudioSource('unexpected')).toBe('both');
    expect(normalizeAudioSource(undefined)).toBe('both');
  });

  it('normalizes capture quality safely', () => {
    expect(normalizeCaptureQuality('auto')).toBe('auto');
    expect(normalizeCaptureQuality('1080p30')).toBe('1080p30');
    expect(normalizeCaptureQuality('1080p60')).toBe('1080p60');
    expect(normalizeCaptureQuality('4k30')).toBe('4k30');
    expect(normalizeCaptureQuality('720p')).toBe('1080p30');
    expect(normalizeCaptureQuality('1080p')).toBe('1080p30');
    expect(normalizeCaptureQuality('unexpected')).toBe('auto');
    expect(normalizeCaptureQuality(undefined)).toBe('auto');
  });

  it('normalizes resolved capture quality including internal fallbacks', () => {
    expect(normalizeResolvedCaptureQuality('1080p30')).toBe('1080p30');
    expect(normalizeResolvedCaptureQuality('1080p60')).toBe('1080p60');
    expect(normalizeResolvedCaptureQuality('1440p30')).toBe('1440p30');
    expect(normalizeResolvedCaptureQuality('4k30')).toBe('4k30');
    expect(normalizeResolvedCaptureQuality('legacy')).toBe('1080p30');
  });

  it('derives system-audio preflight status from source + pipeline', () => {
    expect(getSystemAudioPreflightSnapshot('both', false).systemAudioStatus).toBe('pending');
    expect(getSystemAudioPreflightSnapshot('tab', false).systemAudioStatus).toBe('pending');
    expect(getSystemAudioPreflightSnapshot('mic', false).systemAudioStatus).toBe('idle');
    expect(getSystemAudioPreflightSnapshot('silent', false).systemAudioStatus).toBe('idle');
    expect(getSystemAudioPreflightSnapshot('both', true).systemAudioStatus).toBe('idle');
    expect(getSystemAudioPreflightSnapshot('tab', true).systemAudioStatus).toBe('idle');
  });

  it('normalizes mic device ids', () => {
    expect(normalizeMicDeviceId('device-123')).toBe('device-123');
    expect(normalizeMicDeviceId('  mic-a  ')).toBe('mic-a');
    expect(normalizeMicDeviceId('default')).toBeNull();
    expect(normalizeMicDeviceId('   ')).toBeNull();
    expect(normalizeMicDeviceId(7)).toBeNull();
  });

  it('formats unknown errors into user-safe messages', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
    expect(toErrorMessage('oops')).toBe('oops');
    expect(toErrorMessage({})).toBe('Unknown error');
    expect(toErrorMessage(null)).toBe('Unknown error');
  });

  it('creates deterministic session ids with mocked time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 21, 9, 15, 7));

    expect(createSessionId()).toBe('rec_20260321_091507');

    vi.useRealTimers();
  });

  it('resolves delay after the requested timeout', async () => {
    vi.useFakeTimers();

    let resolved = false;
    const delayed = delay(200).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(199);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await delayed;
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });
});
