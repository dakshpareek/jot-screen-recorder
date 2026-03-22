import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadPersistedContext,
  loadExperimentalFlags,
  saveExperimentalFlags,
  savePersistedContext,
  type PersistedContext,
} from '@/entrypoints/background/state/persisted-context';

const CONTEXT_KEY = 'phase2-recording-context';
const EXPERIMENTAL_FLAGS_KEY = 'experimental-flags';

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
    requestedPreset: '1080p30',
    resolvedPreset: '1080p30',
    recordingQuality: '1080p30',
    usingWebCodecs: true,
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
    webCodecsStats: {
      framesEncoded: 1234,
      bytesWritten: 44_000_000,
      droppedFrames: 2,
      hardwareAccelerated: true,
      memoryPressureTier: 1,
      videoBitrateBps: 5_600_000,
    },
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

  it('migrates legacy persisted quality values on load', async () => {
    getMock.mockResolvedValue({
      [CONTEXT_KEY]: {
        ...createSampleContext(),
        recordingQuality: '720p',
        requestedPreset: undefined,
        resolvedPreset: undefined,
      },
    });

    const result = await loadPersistedContext();

    expect(result?.requestedPreset).toBe('1080p30');
    expect(result?.recordingQuality).toBe('1080p30');
    expect(result?.resolvedPreset).toBeNull();
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

  it('defaults experimental flags to WebCodecs on for new installs', async () => {
    getMock.mockResolvedValue({});

    const flags = await loadExperimentalFlags();

    expect(getMock).toHaveBeenCalledWith(EXPERIMENTAL_FLAGS_KEY);
    expect(flags).toEqual({ useWebCodecs: true });
  });

  it('preserves stored experimental flags when already set', async () => {
    getMock.mockResolvedValue({
      [EXPERIMENTAL_FLAGS_KEY]: { useWebCodecs: false },
    });

    const flags = await loadExperimentalFlags();

    expect(flags).toEqual({ useWebCodecs: false });
  });

  it('saves and returns merged experimental flags', async () => {
    const store: Record<string, unknown> = {
      [EXPERIMENTAL_FLAGS_KEY]: { useWebCodecs: false },
    };
    getMock.mockImplementation(async (key: string) => ({ [key]: store[key] }));
    setMock.mockImplementation(async (value: Record<string, unknown>) => {
      Object.assign(store, value);
    });

    const updated = await saveExperimentalFlags({ useWebCodecs: true });

    expect(updated).toEqual({ useWebCodecs: true });
    expect(store[EXPERIMENTAL_FLAGS_KEY]).toEqual({ useWebCodecs: true });
  });
});
