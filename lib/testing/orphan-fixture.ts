import {
  normalizeCaptureQuality,
  normalizeResolvedCaptureQuality,
} from '@/lib/capture-presets';
import type {
  CaptureQuality,
  CaptureResolvedQuality,
  TestOrphanFixture,
  TestOrphanFixtureSession,
} from '@/lib/messages';

const ORPHAN_FIXTURE_KEY = 'jot-test-orphan-fixture';

const DEFAULT_ORPHAN_FIXTURE: TestOrphanFixture = {
  sessions: [],
};

function normalizeSessionKind(value: unknown): TestOrphanFixtureSession['recordingKind'] {
  if (value === 'mediarecorder' || value === 'webcodecs-opfs') {
    return value;
  }
  return 'webcodecs-opfs';
}

export function normalizeTestOrphanFixtureSession(
  value: unknown,
): TestOrphanFixtureSession | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<TestOrphanFixtureSession>;
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : '';
  const startTime = typeof candidate.startTime === 'number' && Number.isFinite(candidate.startTime)
    ? candidate.startTime
    : null;

  if (!sessionId || startTime == null) {
    return null;
  }

  return {
    sessionId,
    startTime,
    recordingQuality: normalizeCaptureQuality(candidate.recordingQuality as CaptureQuality),
    recordingResolvedQuality: normalizeResolvedCaptureQuality(
      candidate.recordingResolvedQuality as CaptureResolvedQuality,
    ),
    recordingKind: normalizeSessionKind(candidate.recordingKind),
    mimeType:
      typeof candidate.mimeType === 'string'
        ? candidate.mimeType
        : candidate.mimeType == null
          ? undefined
          : String(candidate.mimeType),
    streamBytesWritten:
      typeof candidate.streamBytesWritten === 'number' && Number.isFinite(candidate.streamBytesWritten)
        ? Math.max(1, candidate.streamBytesWritten)
        : 1,
  };
}

function normalizeOrphanFixture(value: unknown): TestOrphanFixture {
  if (value == null || typeof value !== 'object') {
    return { ...DEFAULT_ORPHAN_FIXTURE };
  }

  const candidate = value as Partial<TestOrphanFixture> & { sessions?: unknown };
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions.map(normalizeTestOrphanFixtureSession).filter(Boolean)
    : [];

  return {
    sessions: sessions as TestOrphanFixtureSession[],
  };
}

export async function loadTestOrphanFixture(): Promise<TestOrphanFixture> {
  const stored = await chrome.storage.session.get(ORPHAN_FIXTURE_KEY);
  return normalizeOrphanFixture(stored[ORPHAN_FIXTURE_KEY]);
}

export async function saveTestOrphanFixture(
  fixture: Partial<TestOrphanFixture> | null | undefined,
): Promise<TestOrphanFixture> {
  const normalized = normalizeOrphanFixture(fixture);
  await chrome.storage.session.set({ [ORPHAN_FIXTURE_KEY]: normalized });
  return normalized;
}

export async function resetTestOrphanFixture(): Promise<void> {
  await chrome.storage.session.remove(ORPHAN_FIXTURE_KEY);
}
