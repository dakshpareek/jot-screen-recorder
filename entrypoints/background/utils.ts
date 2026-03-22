import type { AudioSource, CaptureQuality } from '@/lib/messages';
import type { SystemAudioStatus } from '@/lib/recording';

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
  if (value === '720p') {
    return value;
  }
  return '1080p';
}

export function normalizeMicDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'default') return null;
  return trimmed;
}

export function createSessionId() {
  const now = new Date();
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
