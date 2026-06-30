import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadTestOrphanFixture,
  normalizeTestOrphanFixtureSession,
  resetTestOrphanFixture,
  saveTestOrphanFixture,
} from '@/lib/testing/orphan-fixture';

describe('orphan fixture storage contract', () => {
  const getMock = vi.fn();
  const setMock = vi.fn();
  const removeMock = vi.fn();
  let store: Record<string, unknown> = {};

  beforeEach(() => {
    store = {};
    getMock.mockReset();
    setMock.mockReset();
    removeMock.mockReset();

    getMock.mockImplementation(async (key: string) => ({
      [key]: store[key],
    }));
    setMock.mockImplementation(async (value: Record<string, unknown>) => {
      Object.assign(store, value);
    });
    removeMock.mockImplementation(async (key: string) => {
      delete store[key];
    });

    (globalThis as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get: getMock,
          set: setMock,
          remove: removeMock,
        },
      },
    };
  });

  it('saves, loads, and resets orphan fixtures', async () => {
    const saved = await saveTestOrphanFixture({
      sessions: [
        {
          sessionId: 'rec_20260630_101500',
          startTime: 1719724500000,
          recordingQuality: 'auto',
          recordingResolvedQuality: '1080p30',
          recordingKind: 'webcodecs-opfs',
          streamBytesWritten: 1,
        },
      ],
    });

    expect(saved.sessions).toHaveLength(1);
    expect(saved.sessions[0]?.sessionId).toBe('rec_20260630_101500');

    const loaded = await loadTestOrphanFixture();
    expect(loaded.sessions[0]?.recordingKind).toBe('webcodecs-opfs');

    await resetTestOrphanFixture();
    const reset = await loadTestOrphanFixture();
    expect(reset.sessions).toEqual([]);
  });

  it('normalizes malformed orphan fixtures safely', () => {
    expect(
      normalizeTestOrphanFixtureSession({
        sessionId: '',
        startTime: 1,
      }),
    ).toBeNull();

    expect(
      normalizeTestOrphanFixtureSession({
        sessionId: 'rec_1',
        startTime: 1,
        recordingQuality: '1080p',
        recordingResolvedQuality: '720p',
        recordingKind: 'unexpected-kind',
        mimeType: 42 as unknown as string,
        streamBytesWritten: 0,
      }),
    ).toEqual({
      sessionId: 'rec_1',
      startTime: 1,
      recordingQuality: '1080p30',
      recordingResolvedQuality: '1080p30',
      recordingKind: 'webcodecs-opfs',
      mimeType: '42',
      streamBytesWritten: 1,
    });
  });
});
