/**
 * Pure helpers for describing capture-preset fallbacks to the user. No browser
 * APIs, so the fallback-reason copy is unit-testable.
 */
import type { CaptureQuality, CaptureResolvedQuality } from '@/lib/messages';
import { toResolvedQualityLabel } from '@/lib/capture-presets';

export function formatPresetShortLabel(preset: CaptureResolvedQuality) {
  return toResolvedQualityLabel(preset).replace(' • ', ' ');
}

export function buildCaptureFallbackReason(
  requestedPreset: CaptureQuality,
  autoSelectedPreset: CaptureQuality,
  attemptedPreset: CaptureResolvedQuality,
  fallbackChain: CaptureResolvedQuality[],
  previousErrors: string[],
): string | null {
  if (previousErrors.length > 0) {
    const initial = fallbackChain[0] ?? attemptedPreset;
    return `Fell back from ${formatPresetShortLabel(initial)} to ${formatPresetShortLabel(
      attemptedPreset,
    )}.`;
  }
  if (requestedPreset === 'auto') {
    return `Auto selected ${formatPresetShortLabel(autoSelectedPreset)} based on this device.`;
  }
  return null;
}
