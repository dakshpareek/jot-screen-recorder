import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadPersistedContext,
  savePersistedContext,
  type PersistedContext,
} from '@/entrypoints/background/state/persisted-context';

const CONTEXT_KEY = 'phase2-recording-context';

function createSampleContext(): PersistedContext {
  return {
    state: 'processing',
    sessionId: 'rec_20260321_101500',
    recordingStartTime: 1711016100000,
    chunkCount: 4,
    processingProgress: 80,
    errorMessage: null,
    micWarningMessage: null,
    storageWarningMessage: null,
    outputFileName: null,
    recordingQuality: '720p',
    validation: null,
    processingMetrics: null,
    audioPreflight: {
      micChecked: true,
      micOk: true,
      micLevel: 11,
      micError: null,
      systemAudioStatus: 'ok',
      systemAudioLevel: 0.7,
      systemAudioMessage: null,
      needsSystemAudioDecision: false,
    },
    orphanedSessions: [],
    recoverySessionId: null,
    recoveryChunks: [],
  };
}

describe('persisted-context storage contract', () => {
  const getMock = vi.fn();
  const setMock = vi.fn();

  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();

    (globalThis as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: getMock,
          set: setMock,
        },
      },
    };
  });

  it('returns undefined when no persisted payload exists', async () => {
    getMock.mockResolvedValue({});

    const result = await loadPersistedContext();

    expect(getMock).toHaveBeenCalledWith(CONTEXT_KEY);
    expect(result).toBeUndefined();
  });

  it('writes payload under the expected storage key', async () => {
    const payload = createSampleContext();
    setMock.mockResolvedValue(undefined);

    await savePersistedContext(payload);

    expect(setMock).toHaveBeenCalledWith({
      [CONTEXT_KEY]: payload,
    });
  });

  it('round-trips saved payload through storage', async () => {
    const payload = createSampleContext();
    const store: Record<string, unknown> = {};

    setMock.mockImplementation(async (value: Record<string, unknown>) => {
      Object.assign(store, value);
    });
    getMock.mockImplementation(async (key: string) => ({
      [key]: store[key],
    }));

    await savePersistedContext(payload);
    const loaded = await loadPersistedContext();

    expect(loaded).toEqual(payload);
  });

  it('propagates storage read and write failures', async () => {
    setMock.mockRejectedValueOnce(new Error('write-failed'));
    await expect(savePersistedContext(createSampleContext())).rejects.toThrow('write-failed');

    getMock.mockRejectedValueOnce(new Error('read-failed'));
    await expect(loadPersistedContext()).rejects.toThrow('read-failed');
  });
});
