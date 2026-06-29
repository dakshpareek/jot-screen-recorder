import type { AudioSource, CaptureQuality, CaptureResolvedQuality } from '@/lib/messages';
import type { AudioPreflightSnapshot, SystemAudioStatus } from '@/lib/recording';
import {
  normalizeCaptureQuality as normalizeCaptureQualityShared,
  normalizeResolvedCaptureQuality as normalizeResolvedCaptureQualityShared,
} from '@/lib/capture-presets';

export function normalizeSystemAudioStatus(value: unknown): SystemAudioStatus {
  if (value === 'pending' || value === 'ok' || value === 'absent' || value === 'silent') {
    return value;
  }
  return 'idle';
}

export function normalizeAudioSource(value: unknown): AudioSource {
  if (value === 'mic' || value === 'tab' || value === 'silent') {
    return value;
  }
  return 'both';
}

export function normalizeCaptureQuality(value: unknown): CaptureQuality {
  return normalizeCaptureQualityShared(value);
}

export function normalizeResolvedCaptureQuality(value: unknown): CaptureResolvedQuality {
  return normalizeResolvedCaptureQualityShared(value);
}

export function getSystemAudioPreflightSnapshot(
  audioSource: AudioSource,
  usesWebCodecsBackend: boolean,
): Pick<AudioPreflightSnapshot, 'systemAudioStatus' | 'systemAudioLevel'> {
  const shouldRunCheck = !usesWebCodecsBackend && (audioSource === 'both' || audioSource === 'tab');
  return {
    systemAudioStatus: shouldRunCheck ? 'pending' : 'idle',
    systemAudioLevel: null,
  };
}

export function normalizeMicDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'default') return null;
  return trimmed;
}

const EXPORT_PREFIX = 'Jot';
const EXPORT_MAX_LENGTH = 120;
const INVALID_FILENAME_CHAR_PATTERN = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const BROWSER_SUFFIXES = [
  ' - Google Chrome',
  ' - Chromium',
  ' - Microsoft Edge',
  ' - Brave',
  ' - Firefox',
];

function sanitizeFilenameStem(value: string) {
  return value
    .normalize('NFKC')
    .replace(INVALID_FILENAME_CHAR_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
}

function stripBrowserSuffix(title: string) {
  let next = title.trim();
  for (const suffix of BROWSER_SUFFIXES) {
    if (next.toLowerCase().endsWith(suffix.toLowerCase())) {
      next = next.slice(0, -suffix.length).trim();
      break;
    }
  }
  return next;
}

function isPlaceholderTitle(value: string) {
  const lower = value.toLowerCase();
  return (
    lower === 'new tab' ||
    lower === 'untitled' ||
    lower === 'blank page' ||
    lower === 'about:blank'
  );
}

function normalizeHostFromUrl(url: string | null | undefined) {
  if (typeof url !== 'string' || !url.trim()) return null;

  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    const normalized = sanitizeFilenameStem(host);
    return normalized || null;
  } catch {
    return null;
  }
}

function getOutputFileExtension(mimeType: string | null | undefined) {
  const normalized = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('mp4')) return 'mp4';
  return 'mp4';
}

function stripKnownOutputExtension(value: string) {
  return value.replace(/\.(mp4|webm)$/i, '');
}

export function formatRecordingTimestamp(timestampMs = Date.now()) {
  const now = new Date(timestampMs);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}-${mm}-${ss}`;
}

export function buildExportBaseName(options: {
  timestampMs?: number;
  title?: string | null;
  url?: string | null;
  prefix?: string;
  maxLength?: number;
} = {}) {
  const prefix = sanitizeFilenameStem(options.prefix ?? EXPORT_PREFIX) || EXPORT_PREFIX;
  const timestamp = formatRecordingTimestamp(options.timestampMs ?? Date.now());
  const cleanTitle = sanitizeFilenameStem(stripBrowserSuffix(options.title ?? ''));
  const titleLabel = cleanTitle && !isPlaceholderTitle(cleanTitle) ? cleanTitle : '';
  const hostLabel = normalizeHostFromUrl(options.url) ?? '';
  const label = titleLabel || hostLabel;
  const maxLength = options.maxLength ?? EXPORT_MAX_LENGTH;
  const fixedStem = `${prefix} - ${timestamp}`;

  if (!label) {
    return sanitizeFilenameStem(fixedStem).slice(0, maxLength) || fixedStem;
  }

  const rawStem = `${fixedStem} - ${label}`;
  if (rawStem.length <= maxLength) {
    return sanitizeFilenameStem(rawStem);
  }

  const availableLabelLength = Math.max(0, maxLength - `${fixedStem} - `.length);
  if (!availableLabelLength) {
    return sanitizeFilenameStem(fixedStem).slice(0, maxLength) || fixedStem;
  }

  const truncatedLabel = label.slice(0, availableLabelLength).replace(/[. ]+$/g, '');
  return sanitizeFilenameStem(`${fixedStem} - ${truncatedLabel}`);
}

export function buildDownloadFileName(baseName: string | null | undefined, mimeType: string | null | undefined) {
  const stem = sanitizeFilenameStem(
    stripKnownOutputExtension(typeof baseName === 'string' && baseName.trim() ? baseName.trim() : 'recording'),
  ) || 'recording';
  return `${stem}.${getOutputFileExtension(mimeType)}`;
}

export function buildRawExportBaseName(
  baseName: string | null | undefined,
  sessionId: string | null | undefined,
) {
  const stemSource =
    typeof baseName === 'string' && baseName.trim()
      ? baseName.trim()
      : typeof sessionId === 'string' && sessionId.trim()
        ? sessionId.trim()
        : 'recording';
  const stem = sanitizeFilenameStem(stripKnownOutputExtension(stemSource)) || 'recording';
  return `${stem}-raw`;
}

export function createSessionId(timestampMs: number | Date = Date.now()) {
  const now = typeof timestampMs === 'number' ? new Date(timestampMs) : timestampMs;
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `rec_${y}${m}${d}_${hh}${mm}${ss}`;
}

export function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}
