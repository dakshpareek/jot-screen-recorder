import type { CaptureQuality, CaptureResolvedQuality } from './messages';

export type LegacyCaptureQuality = '720p' | '1080p';

export const DEFAULT_CAPTURE_QUALITY: CaptureQuality = 'auto';
export const DEFAULT_RESOLVED_CAPTURE_QUALITY: CaptureResolvedQuality = '1080p30';

export interface CaptureProfile {
  width: number;
  height: number;
  fps: number;
  bitrateBps: number;
  minBitrateBps: number;
}

export interface CaptureRuntimeHints {
  maxWidth?: number | null;
  maxHeight?: number | null;
  deviceMemoryGB?: number | null;
  hardwareConcurrency?: number | null;
}

export interface CapturePresetResolution {
  requestedPreset: CaptureQuality;
  autoSelectedPreset: Exclude<CaptureQuality, 'auto'>;
  fallbackChain: CaptureResolvedQuality[];
}

export const RESOLVED_CAPTURE_PROFILES: Record<CaptureResolvedQuality, CaptureProfile> = {
  '1080p30': {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateBps: 4_000_000,
    minBitrateBps: 1_200_000,
  },
  '1080p60': {
    width: 1920,
    height: 1080,
    fps: 60,
    bitrateBps: 7_000_000,
    minBitrateBps: 1_800_000,
  },
  '1440p30': {
    width: 2560,
    height: 1440,
    fps: 30,
    bitrateBps: 9_000_000,
    minBitrateBps: 2_500_000,
  },
  '4k30': {
    width: 3840,
    height: 2160,
    fps: 30,
    bitrateBps: 14_000_000,
    minBitrateBps: 4_000_000,
  },
  auto: {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateBps: 4_000_000,
    minBitrateBps: 1_200_000,
  },
};

const FALLBACK_CHAINS: Record<Exclude<CaptureQuality, 'auto'>, CaptureResolvedQuality[]> = {
  '1080p30': ['1080p30'],
  '1080p60': ['1080p60', '1080p30'],
  '4k30': ['4k30', '1440p30', '1080p30'],
};

function normalizePositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function normalizedOrientation(width: number, height: number): [number, number] {
  return width >= height ? [width, height] : [height, width];
}

function profileFitsBounds(
  preset: CaptureResolvedQuality,
  maxWidth: number | null,
  maxHeight: number | null,
): boolean {
  if (!maxWidth || !maxHeight) return true;

  const profile = RESOLVED_CAPTURE_PROFILES[preset];
  const [profileLong, profileShort] = normalizedOrientation(profile.width, profile.height);
  const [maxLong, maxShort] = normalizedOrientation(maxWidth, maxHeight);
  return profileLong <= maxLong && profileShort <= maxShort;
}

export function normalizeCaptureQuality(value: unknown): CaptureQuality {
  if (value === 'auto' || value === '1080p30' || value === '1080p60' || value === '4k30') {
    return value;
  }
  if (value === '720p' || value === '1080p') {
    return '1080p30';
  }
  return DEFAULT_CAPTURE_QUALITY;
}

export function normalizeResolvedCaptureQuality(value: unknown): CaptureResolvedQuality {
  if (value === 'auto' || value === '1080p30' || value === '1080p60' || value === '1440p30' || value === '4k30') {
    return value;
  }
  if (value === '720p' || value === '1080p') {
    return '1080p30';
  }
  return DEFAULT_RESOLVED_CAPTURE_QUALITY;
}

export function getCaptureProfile(preset: CaptureResolvedQuality): CaptureProfile {
  return RESOLVED_CAPTURE_PROFILES[preset];
}

export function getRuntimeHintsFromNavigator(): CaptureRuntimeHints {
  const screenObj =
    typeof globalThis !== 'undefined' && typeof globalThis.screen !== 'undefined'
      ? globalThis.screen
      : null;
  const dpr =
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { devicePixelRatio?: number }).devicePixelRatio === 'number'
      ? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1
      : 1;
  const maxWidth = screenObj ? Math.round(screenObj.width * dpr) : null;
  const maxHeight = screenObj ? Math.round(screenObj.height * dpr) : null;
  const deviceMemoryGB =
    typeof navigator !== 'undefined' && 'deviceMemory' in navigator
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null
      : null;
  const hardwareConcurrency =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : null;

  return {
    maxWidth,
    maxHeight,
    deviceMemoryGB,
    hardwareConcurrency,
  };
}

export function resolveAutoPreset(hints: CaptureRuntimeHints = {}): Exclude<CaptureQuality, 'auto'> {
  const maxWidth = normalizePositiveNumber(hints.maxWidth);
  const maxHeight = normalizePositiveNumber(hints.maxHeight);
  const memory = normalizePositiveNumber(hints.deviceMemoryGB);
  const cores = normalizePositiveNumber(hints.hardwareConcurrency);
  const hasStrongCpu = cores !== null && cores >= 8;
  const hasHighMemory = memory !== null && memory >= 8;
  const hasMidMemory = memory !== null && memory >= 6;
  const supports4k = profileFitsBounds('4k30', maxWidth, maxHeight);
  const supports1080 = profileFitsBounds('1080p30', maxWidth, maxHeight);

  if (supports4k && hasHighMemory && hasStrongCpu) {
    return '4k30';
  }
  if (supports1080 && hasMidMemory && hasStrongCpu) {
    return '1080p60';
  }
  return '1080p30';
}

export function resolveCapturePreset(
  requestedPreset: CaptureQuality,
  hints: CaptureRuntimeHints = {},
): CapturePresetResolution {
  const normalizedRequested = normalizeCaptureQuality(requestedPreset);
  const maxWidth = normalizePositiveNumber(hints.maxWidth);
  const maxHeight = normalizePositiveNumber(hints.maxHeight);
  const autoSelectedPreset =
    normalizedRequested === 'auto' ? resolveAutoPreset(hints) : normalizedRequested;
  const chainBase = FALLBACK_CHAINS[autoSelectedPreset];
  const filtered = chainBase.filter((preset) => profileFitsBounds(preset, maxWidth, maxHeight));
  const fallbackChain: CaptureResolvedQuality[] = filtered.length ? filtered : ['1080p30'];
  return {
    requestedPreset: normalizedRequested,
    autoSelectedPreset,
    fallbackChain,
  };
}

export function toCaptureQualityLabel(preset: CaptureQuality): string {
  if (preset === 'auto') return 'Auto';
  if (preset === '1080p30') return '1080p • 30fps';
  if (preset === '1080p60') return '1080p • 60fps';
  return '4K • 30fps';
}

export function toResolvedQualityLabel(preset: CaptureResolvedQuality): string {
  if (preset === 'auto') return 'Auto';
  if (preset === '1440p30') return '1440p • 30fps';
  return toCaptureQualityLabel(preset);
}
