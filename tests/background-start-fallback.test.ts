import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeMessageType } from '@/lib/messages';

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
        download: vi.fn().mockResolvedValue(1),
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
});
