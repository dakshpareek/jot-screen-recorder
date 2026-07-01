import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeMessageType } from '@/lib/messages';
import { buildDownloadFileName, buildExportBaseName } from '@/entrypoints/background/utils';

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => void | boolean;

const offscreenSendMock = vi.fn();
const ensureReadyMock = vi.fn(async () => {});

const loadPersistedContextMock = vi.fn();
const savePersistedContextMock = vi.fn();
const loadRecorderSettingsMock = vi.fn();
const saveRecorderSettingsMock = vi.fn();
const downloadsDownloadMock = vi.fn();
const storageSessionGetMock = vi.fn();
const storageSessionSetMock = vi.fn();
const storageSessionRemoveMock = vi.fn();
const permissionsQueryMock = vi.fn();
let sessionStore: Record<string, unknown> = {};

vi.mock('@/entrypoints/background/services/offscreen-client', () => {
  class MockOffscreenClient {
    markReady() {}

    async send<T>(message: Record<string, unknown>): Promise<T> {
      return await offscreenSendMock(message);
    }

    async ensureReadyWithRetry() {
      await ensureReadyMock();
    }
  }

  return {
    OffscreenClient: MockOffscreenClient,
  };
});

vi.mock('@/entrypoints/background/state/persisted-context', () => ({
  WEBCODECS_KILL_SWITCH_FORCE_LEGACY: false,
  loadPersistedContext: loadPersistedContextMock,
  savePersistedContext: savePersistedContextMock,
  loadRecorderSettings: loadRecorderSettingsMock,
  saveRecorderSettings: saveRecorderSettingsMock,
}));

describe('background start fallback', () => {
  let runtimeListener: RuntimeListener | null = null;
  const onMessageAddListenerMock = vi.fn();
  const onUpdatedAddListenerMock = vi.fn();
  const onInstalledAddListenerMock = vi.fn();
  const runtimeSendMessageMock = vi.fn();
  const tabsQueryMock = vi.fn();
  const tabsCreateMock = vi.fn();
  const tabsSendMessageMock = vi.fn();
  const executeScriptMock = vi.fn();
  const setBadgeTextMock = vi.fn();
  const setBadgeBackgroundColorMock = vi.fn();
  const tabCaptureGetMediaStreamIdMock = vi.fn();

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  async function bootBackground() {
    await import('@/entrypoints/background');
    await flush();
    if (!runtimeListener) {
      throw new Error('runtime listener was not registered');
    }
  }

  async function dispatchRuntimeMessage(message: Record<string, unknown>) {
    if (!runtimeListener) {
      throw new Error('missing runtime listener');
    }
    const listener = runtimeListener;
    return await new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`timeout waiting for response to ${String(message.type)}`));
      }, 200);
      const sendResponse = (response?: unknown) => {
        clearTimeout(timeoutId);
        resolve(response);
      };
      listener(message, {} as chrome.runtime.MessageSender, sendResponse);
    });
  }

  beforeEach(() => {
    vi.resetModules();
    offscreenSendMock.mockReset();
    ensureReadyMock.mockReset();
    loadPersistedContextMock.mockReset();
    savePersistedContextMock.mockReset();
    loadRecorderSettingsMock.mockReset();
    saveRecorderSettingsMock.mockReset();
    downloadsDownloadMock.mockReset();
    storageSessionGetMock.mockReset();
    storageSessionSetMock.mockReset();
    storageSessionRemoveMock.mockReset();
    permissionsQueryMock.mockReset();
    sessionStore = {};
    onMessageAddListenerMock.mockReset();
    onUpdatedAddListenerMock.mockReset();
    onInstalledAddListenerMock.mockReset();
    runtimeSendMessageMock.mockReset();
    tabsQueryMock.mockReset();
    tabsCreateMock.mockReset();
    tabsSendMessageMock.mockReset();
    executeScriptMock.mockReset();
    setBadgeTextMock.mockReset();
    setBadgeBackgroundColorMock.mockReset();
    tabCaptureGetMediaStreamIdMock.mockReset();
    runtimeListener = null;

    onMessageAddListenerMock.mockImplementation((listener: RuntimeListener) => {
      runtimeListener = listener;
    });
    onUpdatedAddListenerMock.mockImplementation(() => {});
    onInstalledAddListenerMock.mockImplementation(() => {});
    runtimeSendMessageMock.mockResolvedValue(undefined);
    tabsQueryMock.mockResolvedValue([{ id: 101 }]);
    tabsCreateMock.mockResolvedValue({ id: 202 });
    tabsSendMessageMock.mockResolvedValue(true);
    tabCaptureGetMediaStreamIdMock.mockImplementation((_options: unknown, callback: (streamId: string) => void) => {
      callback('stream-101');
    });
    loadPersistedContextMock.mockResolvedValue(undefined);
    savePersistedContextMock.mockResolvedValue(undefined);
    loadRecorderSettingsMock.mockResolvedValue({ encoderBackend: 'webcodecs' });
    saveRecorderSettingsMock.mockResolvedValue({ encoderBackend: 'webcodecs' });
    downloadsDownloadMock.mockResolvedValue(1);
    storageSessionGetMock.mockImplementation(async (keys?: string | string[] | Record<string, unknown>) => {
      if (typeof keys === 'string') {
        return { [keys]: sessionStore[keys] };
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, sessionStore[key]]));
      }
      if (keys && typeof keys === 'object') {
        return Object.fromEntries(
          Object.entries(keys).map(([key, defaultValue]) => [key, key in sessionStore ? sessionStore[key] : defaultValue]),
        );
      }
      return { ...sessionStore };
    });
    storageSessionSetMock.mockImplementation(async (value: Record<string, unknown>) => {
      sessionStore = { ...sessionStore, ...value };
    });
    storageSessionRemoveMock.mockImplementation(async (keys: string | string[]) => {
      const removalKeys = Array.isArray(keys) ? keys : [keys];
      for (const key of removalKeys) {
        delete sessionStore[key];
      }
    });
    permissionsQueryMock.mockResolvedValue({ state: 'granted' });
    offscreenSendMock.mockImplementation(async (message: { type?: string }) => {
      if (message.type === RuntimeMessageType.OFFSCREEN_SCAN_ORPHANS) {
        return { ok: true, sessions: [] };
      }
      return { ok: true };
    });

    (globalThis as { defineBackground?: unknown }).defineBackground = (callback: () => void) => callback();
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        storage: {
          estimate: vi.fn().mockResolvedValue({
            quota: 10_000_000_000,
            usage: 100_000_000,
          }),
        },
        permissions: {
          query: permissionsQueryMock,
        },
      },
      configurable: true,
      writable: true,
    });

    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        onMessage: {
          addListener: onMessageAddListenerMock,
        },
        onInstalled: {
          addListener: onInstalledAddListenerMock,
        },
        sendMessage: runtimeSendMessageMock,
        lastError: undefined,
      },
      storage: {
        session: {
          get: storageSessionGetMock,
          set: storageSessionSetMock,
          remove: storageSessionRemoveMock,
        },
      },
      tabs: {
        onUpdated: {
          addListener: onUpdatedAddListenerMock,
        },
        query: tabsQueryMock,
        create: tabsCreateMock,
        sendMessage: tabsSendMessageMock,
      },
      tabCapture: {
        getMediaStreamId: tabCaptureGetMediaStreamIdMock,
      },
      action: {
        setBadgeText: setBadgeTextMock,
        setBadgeBackgroundColor: setBadgeBackgroundColorMock,
      },
      scripting: {
        executeScript: executeScriptMock.mockResolvedValue(undefined),
      },
      downloads: {
        download: downloadsDownloadMock,
      },
    };
  });

  it('falls back to MediaRecorder when WebCodecs start fails', async () => {
    await bootBackground();
    offscreenSendMock.mockClear();

    offscreenSendMock.mockImplementation(async (message: { type?: string }) => {
      if (message.type === RuntimeMessageType.OFFSCREEN_START_WEBCODECS) {
        return { ok: false, error: 'webcodecs unavailable' };
      }
      if (message.type === RuntimeMessageType.OFFSCREEN_START) {
        return { ok: true, requestedPreset: 'auto', resolvedPreset: '1080p30' };
      }
      return { ok: true };
    });

    const prep = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.PREPARE_START,
      includeMic: false,
      quality: 'auto',
    })) as { ok?: boolean };
    expect(prep?.ok).toBe(true);

    const start = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.START,
      audioSource: 'tab',
      quality: 'auto',
    })) as { ok?: boolean; snapshot?: { state?: string } };

    expect(start?.ok).toBe(true);
    expect(start?.snapshot?.state).toBe('recording');
    expect(offscreenSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: RuntimeMessageType.OFFSCREEN_START_WEBCODECS }),
    );
    expect(offscreenSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: RuntimeMessageType.OFFSCREEN_START }),
    );
  });

  it('returns preflight error when WebCodecs and MediaRecorder start both fail', async () => {
    await bootBackground();
    offscreenSendMock.mockClear();

    offscreenSendMock.mockImplementation(async (message: { type?: string }) => {
      if (message.type === RuntimeMessageType.OFFSCREEN_START_WEBCODECS) {
        return { ok: false, error: 'wc failed' };
      }
      if (message.type === RuntimeMessageType.OFFSCREEN_START) {
        return { ok: false, error: 'legacy failed' };
      }
      return { ok: true };
    });

    const prep = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.PREPARE_START,
      includeMic: false,
      quality: 'auto',
    })) as { ok?: boolean };
    expect(prep?.ok).toBe(true);

    const start = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.START,
      audioSource: 'tab',
      quality: 'auto',
    })) as { ok?: boolean; error?: string; snapshot?: { state?: string } };

    expect(start?.ok).toBe(false);
    expect(start?.snapshot?.state).toBe('preflight_error');
    expect(start?.error).toContain('WebCodecs start failed (wc failed)');
    expect(start?.error).toContain('MediaRecorder fallback also failed: legacy failed');
  });

  it('honors the prompt permission fixture during mic checks', async () => {
    sessionStore['jot-test-permission-fixture'] = { microphone: 'prompt' };
    await bootBackground();
    offscreenSendMock.mockClear();

    offscreenSendMock.mockImplementation(async (message: { type?: string; permissionState?: string }) => {
      if (message.type === RuntimeMessageType.MIC_PREFLIGHT) {
        return message.permissionState === 'prompt'
          ? { ok: false, error: 'MIC_PERMISSION_PROMPT' }
          : { ok: false, error: 'MIC_PERMISSION_DENIED' };
      }
      return { ok: true };
    });

    const micCheck = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.RUN_MIC_CHECK,
    })) as { ok?: boolean; error?: string; snapshot?: { audioPreflight?: { micError?: string } } };

    expect(micCheck?.ok).toBe(false);
    expect(micCheck?.error).toBe('MIC_PERMISSION_PROMPT');
    expect(micCheck?.snapshot?.audioPreflight?.micError).toBe('MIC_PERMISSION_PROMPT');
    expect(offscreenSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: RuntimeMessageType.MIC_PREFLIGHT,
        permissionState: 'prompt',
      }),
    );
  });

  it('reacquires tab capture before retrying MediaRecorder fallback', async () => {
    tabCaptureGetMediaStreamIdMock
      .mockImplementationOnce((_options: unknown, callback: (streamId: string) => void) => {
        callback('stream-webcodecs');
      })
      .mockImplementationOnce((_options: unknown, callback: (streamId: string) => void) => {
        callback('stream-mediarecorder');
      });

    await bootBackground();
    offscreenSendMock.mockClear();

    offscreenSendMock.mockImplementation(async (message: { type?: string }) => {
      if (message.type === RuntimeMessageType.OFFSCREEN_START_WEBCODECS) {
        return { ok: false, error: 'webcodecs attach failed' };
      }
      if (message.type === RuntimeMessageType.OFFSCREEN_START) {
        return { ok: true, requestedPreset: 'auto', resolvedPreset: '1080p30' };
      }
      return { ok: true };
    });

    const prep = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.PREPARE_START,
      includeMic: false,
      quality: 'auto',
    })) as { ok?: boolean };
    expect(prep?.ok).toBe(true);

    const start = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.START,
      audioSource: 'tab',
      quality: 'auto',
    })) as { ok?: boolean; snapshot?: { state?: string } };

    expect(start?.ok).toBe(true);
    expect(start?.snapshot?.state).toBe('recording');
    expect(tabCaptureGetMediaStreamIdMock).toHaveBeenCalledTimes(2);
    expect(offscreenSendMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: RuntimeMessageType.OFFSCREEN_START_WEBCODECS,
        streamId: 'stream-webcodecs',
      }),
    );
    expect(offscreenSendMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: RuntimeMessageType.OFFSCREEN_START,
        streamId: 'stream-mediarecorder',
      }),
    );
  });

  it('returns explicit tab-not-capturable error for browser-internal pages', async () => {
    tabsQueryMock.mockResolvedValue([{ id: 101, url: 'chrome://extensions' }]);

    await bootBackground();
    offscreenSendMock.mockClear();

    const prep = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.PREPARE_START,
      includeMic: false,
      quality: 'auto',
    })) as { ok?: boolean };
    expect(prep?.ok).toBe(true);

    const start = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.START,
      audioSource: 'tab',
      quality: 'auto',
    })) as { ok?: boolean; error?: string; snapshot?: { state?: string } };

    expect(start?.ok).toBe(false);
    expect(start?.snapshot?.state).toBe('preflight_error');
    expect(start?.error).toContain('TAB_NOT_CAPTURABLE:');
    expect(start?.error).toContain('regular webpage');
    expect(offscreenSendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: RuntimeMessageType.OFFSCREEN_START_WEBCODECS }),
    );
    expect(offscreenSendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: RuntimeMessageType.OFFSCREEN_START }),
    );
  });

  it('prefers a capturable webpage over the popup tab when resolving the start target', async () => {
    tabsQueryMock.mockResolvedValue([
      { id: 101, url: 'chrome-extension://hknbhnckdfacgcdnmefhcagnhebjpbcc/popup.html' },
      { id: 202, url: 'https://example.com/' },
    ]);

    await bootBackground();
    offscreenSendMock.mockClear();

    offscreenSendMock.mockImplementation(async (message: { type?: string }) => {
      if (message.type === RuntimeMessageType.OFFSCREEN_START_WEBCODECS) {
        return { ok: true, requestedPreset: 'auto', resolvedPreset: '1080p30' };
      }
      return { ok: true };
    });

    const prep = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.PREPARE_START,
      includeMic: false,
      quality: 'auto',
    })) as { ok?: boolean };
    expect(prep?.ok).toBe(true);

    const start = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.START,
      audioSource: 'tab',
      quality: 'auto',
    })) as { ok?: boolean; snapshot?: { state?: string } };

    expect(start?.ok).toBe(true);
    expect(start?.snapshot?.state).toBe('recording');
    expect(tabCaptureGetMediaStreamIdMock).toHaveBeenCalledWith(
      { targetTabId: 202 },
      expect.any(Function),
    );
  });

  it('opens extension-specific microphone site settings', async () => {
    (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome!.runtime!.id = 'test-extension-id';

    await bootBackground();

    const response = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.OPEN_MIC_SETTINGS,
    })) as { ok?: boolean };

    expect(response?.ok).toBe(true);
    expect(tabsCreateMock).toHaveBeenCalledWith({
      url: 'chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2Ftest-extension-id',
    });
  });

  it('injects content script fallback when recording banner target tab has no listener', async () => {
    tabsSendMessageMock
      .mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'))
      .mockResolvedValue(true);

    await bootBackground();
    offscreenSendMock.mockClear();

    offscreenSendMock.mockImplementation(async (message: { type?: string }) => {
      if (message.type === RuntimeMessageType.OFFSCREEN_START_WEBCODECS) {
        return { ok: true, requestedPreset: 'auto', resolvedPreset: '1080p30' };
      }
      return { ok: true };
    });

    const prep = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.PREPARE_START,
      includeMic: false,
      quality: 'auto',
    })) as { ok?: boolean };
    expect(prep?.ok).toBe(true);

    const start = (await dispatchRuntimeMessage({
      type: RuntimeMessageType.START,
      audioSource: 'tab',
      quality: 'auto',
    })) as { ok?: boolean; snapshot?: { state?: string } };

    expect(start?.ok).toBe(true);
    expect(start?.snapshot?.state).toBe('recording');
    await flush();
    expect(executeScriptMock).toHaveBeenCalledWith({
      target: { tabId: 101 },
      files: ['content-scripts/content.js'],
    });
    expect(tabsSendMessageMock).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ type: RuntimeMessageType.RECORDING_BANNER, visible: true }),
    );
  });

  it('prepopulates a stemmed WebCodecs download filename from the active tab title', async () => {
    vi.useFakeTimers();
    try {
      const timestampMs = new Date(2026, 5, 29, 14, 30, 12).getTime();
      vi.setSystemTime(timestampMs);
      tabsQueryMock.mockResolvedValue([{ id: 101, title: 'ChatGPT', url: 'https://chatgpt.com/chat' }]);

      await bootBackground();
      offscreenSendMock.mockClear();

      offscreenSendMock.mockImplementation(async (message: { type?: string }) => {
        if (message.type === RuntimeMessageType.OFFSCREEN_SCAN_ORPHANS) {
          return { ok: true, sessions: [] };
        }
        if (message.type === RuntimeMessageType.OFFSCREEN_START_WEBCODECS) {
          return {
            ok: true,
            requestedPreset: 'auto',
            resolvedPreset: '1080p30',
            outputMimeType: 'video/webm',
          };
        }
        if (message.type === RuntimeMessageType.OFFSCREEN_STOP_WEBCODECS) {
          return { ok: true, outputUrl: 'blob:webcodecs', outputMimeType: 'video/webm' };
        }
        return { ok: true };
      });

      const prep = (await dispatchRuntimeMessage({
        type: RuntimeMessageType.PREPARE_START,
        includeMic: false,
        quality: 'auto',
      })) as { ok?: boolean };
      expect(prep?.ok).toBe(true);

      const start = (await dispatchRuntimeMessage({
        type: RuntimeMessageType.START,
        audioSource: 'tab',
        quality: 'auto',
      })) as { ok?: boolean; snapshot?: { state?: string } };

      expect(start?.ok).toBe(true);
      expect(start?.snapshot?.state).toBe('recording');

      const expectedStem = buildExportBaseName({
        timestampMs,
        title: 'ChatGPT',
        url: 'https://chatgpt.com/chat',
      });

      expect(offscreenSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: RuntimeMessageType.OFFSCREEN_START_WEBCODECS,
          exportBaseName: expectedStem,
          recordingStartTime: timestampMs,
        }),
      );

      const stop = (await dispatchRuntimeMessage({
        type: RuntimeMessageType.STOP,
      })) as { ok?: boolean };
      expect(stop?.ok).toBe(true);

      const download = (await dispatchRuntimeMessage({
        type: RuntimeMessageType.DOWNLOAD,
      })) as { ok?: boolean };
      expect(download?.ok).toBe(true);
      expect(downloadsDownloadMock).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: buildDownloadFileName(expectedStem, 'video/webm'),
          saveAs: true,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('prepopulates a stemmed MediaRecorder download filename from the active tab title', async () => {
    vi.useFakeTimers();
    try {
      const timestampMs = new Date(2026, 5, 29, 14, 30, 12).getTime();
      vi.setSystemTime(timestampMs);
      tabsQueryMock.mockResolvedValue([{ id: 101, title: 'ChatGPT', url: 'https://chatgpt.com/chat' }]);
      loadRecorderSettingsMock.mockResolvedValue({ encoderBackend: 'mediarecorder' });

      await bootBackground();
      offscreenSendMock.mockClear();

      offscreenSendMock.mockImplementation(async (message: { type?: string }) => {
        if (message.type === RuntimeMessageType.OFFSCREEN_SCAN_ORPHANS) {
          return { ok: true, sessions: [] };
        }
        if (message.type === RuntimeMessageType.OFFSCREEN_START) {
          return {
            ok: true,
            requestedPreset: 'auto',
            resolvedPreset: '1080p30',
            outputMimeType: 'video/mp4',
          };
        }
        if (message.type === RuntimeMessageType.OFFSCREEN_STOP) {
          return { ok: true };
        }
        if (message.type === RuntimeMessageType.OFFSCREEN_PROCESS) {
          return {
            ok: true,
            outputUrl: 'blob:mediarecorder',
            outputMimeType: 'video/mp4',
          };
        }
        if (message.type === RuntimeMessageType.OFFSCREEN_VALIDATE) {
          return {
            passed: true,
            checks: {
              size: true,
              header: true,
              duration: true,
            },
          };
        }
        return { ok: true };
      });

      const prep = (await dispatchRuntimeMessage({
        type: RuntimeMessageType.PREPARE_START,
        includeMic: false,
        quality: 'auto',
      })) as { ok?: boolean };
      expect(prep?.ok).toBe(true);

      const start = (await dispatchRuntimeMessage({
        type: RuntimeMessageType.START,
        audioSource: 'tab',
        quality: 'auto',
      })) as { ok?: boolean; snapshot?: { state?: string } };

      expect(start?.ok).toBe(true);
      expect(start?.snapshot?.state).toBe('recording');

      const expectedStem = buildExportBaseName({
        timestampMs,
        title: 'ChatGPT',
        url: 'https://chatgpt.com/chat',
      });

      expect(offscreenSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: RuntimeMessageType.OFFSCREEN_START,
          exportBaseName: expectedStem,
          recordingStartTime: timestampMs,
        }),
      );

      const stop = (await dispatchRuntimeMessage({
        type: RuntimeMessageType.STOP,
      })) as { ok?: boolean };
      expect(stop?.ok).toBe(true);

      const processed = (await dispatchRuntimeMessage({
        type: RuntimeMessageType.OFFSCREEN_EVENT,
        event: 'FINAL_CHUNK_WRITTEN',
        chunkCount: 1,
      })) as { ok?: boolean };
      expect(processed?.ok).toBe(true);

      const download = (await dispatchRuntimeMessage({
        type: RuntimeMessageType.DOWNLOAD,
      })) as { ok?: boolean };
      expect(download?.ok).toBe(true);
      expect(downloadsDownloadMock).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: buildDownloadFileName(expectedStem, 'video/mp4'),
          saveAs: true,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
