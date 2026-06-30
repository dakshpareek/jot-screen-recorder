import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadTestCaptureFixture,
  normalizeTestActiveTabFixture,
  resetTestCaptureFixture,
  saveTestCaptureFixture,
} from '@/lib/testing/capture-fixture';

describe('capture fixture storage contract', () => {
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

  it('saves, loads, and resets capture fixtures', async () => {
    const saved = await saveTestCaptureFixture({
      activeTab: {
        id: 101,
        title: 'Example Domain',
        url: 'https://example.com/',
      },
    });
    expect(saved.activeTab?.id).toBe(101);

    const loaded = await loadTestCaptureFixture();
    expect(loaded.activeTab?.title).toBe('Example Domain');

    await resetTestCaptureFixture();
    const reset = await loadTestCaptureFixture();
    expect(reset.activeTab).toBeNull();
  });

  it('normalizes malformed tab fixtures to null', () => {
    expect(normalizeTestActiveTabFixture({ id: 0 })).toBeNull();
    expect(normalizeTestActiveTabFixture({ id: 1, title: 42 as unknown as string })).toEqual({
      id: 1,
      title: '42',
      url: null,
    });
  });
});
