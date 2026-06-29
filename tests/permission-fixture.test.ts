import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadTestPermissionFixture,
  normalizeTestPermissionState,
  resetTestPermissionFixture,
  resolveMicrophonePermissionState,
  saveTestPermissionFixture,
} from '@/lib/testing/permission-fixture';

describe('permission fixture storage contract', () => {
  const getMock = vi.fn();
  const setMock = vi.fn();
  const removeMock = vi.fn();
  const permissionsQueryMock = vi.fn();
  let store: Record<string, unknown> = {};

  beforeEach(() => {
    store = {};
    getMock.mockReset();
    setMock.mockReset();
    removeMock.mockReset();
    permissionsQueryMock.mockReset();

    getMock.mockImplementation(async (key: string) => ({
      [key]: store[key],
    }));
    setMock.mockImplementation(async (value: Record<string, unknown>) => {
      Object.assign(store, value);
    });
    removeMock.mockImplementation(async (key: string) => {
      delete store[key];
    });
    permissionsQueryMock.mockResolvedValue({ state: 'granted' });

    (globalThis as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get: getMock,
          set: setMock,
          remove: removeMock,
        },
      },
    };
    (globalThis as { navigator: unknown }).navigator = {
      permissions: {
        query: permissionsQueryMock,
      },
    };
  });

  it('saves, loads, and resets permission fixtures', async () => {
    const saved = await saveTestPermissionFixture({ microphone: 'denied' });
    expect(saved).toEqual({ microphone: 'denied' });

    const loaded = await loadTestPermissionFixture();
    expect(loaded).toEqual({ microphone: 'denied' });

    await resetTestPermissionFixture();
    const reset = await loadTestPermissionFixture();
    expect(reset).toEqual({ microphone: 'unset' });
  });

  it('prefers the stored fixture over navigator.permissions.query', async () => {
    await saveTestPermissionFixture({ microphone: 'prompt' });

    const resolved = await resolveMicrophonePermissionState();

    expect(resolved).toBe('prompt');
    expect(permissionsQueryMock).not.toHaveBeenCalled();
  });

  it('falls back to browser permission state when the fixture is unset', async () => {
    const resolved = await resolveMicrophonePermissionState();

    expect(resolved).toBe('granted');
    expect(permissionsQueryMock).toHaveBeenCalledWith({
      name: 'microphone',
    });
  });

  it('normalizes malformed fixture states to unset', () => {
    expect(normalizeTestPermissionState('unexpected')).toBe('unset');
    expect(normalizeTestPermissionState('granted')).toBe('granted');
  });
});
