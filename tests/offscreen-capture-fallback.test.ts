import { describe, expect, it } from 'vitest';
import {
  buildCaptureFallbackReason,
  formatPresetShortLabel,
} from '@/entrypoints/offscreen/media/capture-fallback';

describe('capture-fallback', () => {
  it('renders a short preset label without the bullet separator', () => {
    const label = formatPresetShortLabel('1080p30');
    expect(label).not.toContain('•');
    expect(label.length).toBeGreaterThan(0);
  });

  it('describes a fallback when earlier presets failed', () => {
    const reason = buildCaptureFallbackReason(
      '4k30',
      '4k30',
      '1080p30',
      ['4k30', '1080p60', '1080p30'],
      ['4k30: NotReadableError'],
    );
    expect(reason).toContain('Fell back from');
    expect(reason).toContain(formatPresetShortLabel('4k30'));
    expect(reason).toContain(formatPresetShortLabel('1080p30'));
  });

  it('explains an auto-selected preset when nothing failed', () => {
    const reason = buildCaptureFallbackReason('auto', '1080p60', '1080p60', ['1080p60'], []);
    expect(reason).toContain('Auto selected');
    expect(reason).toContain(formatPresetShortLabel('1080p60'));
  });

  it('returns null for an explicit preset that succeeded first try', () => {
    expect(buildCaptureFallbackReason('1080p60', '1080p60', '1080p60', ['1080p60'], [])).toBeNull();
  });
});
