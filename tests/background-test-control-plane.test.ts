import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildDownloadFileName, buildExportBaseName } from '@/entrypoints/background/utils';
import { RuntimeMessageType } from '@/lib/messages';
import type { PersistedContext } from '@/entrypoints/background/state/persisted-context';

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

vi.mock('@/entrypoints/background/services/offscreen-client', () => {
  class MockOffscreenClient {
    markReady() {}

    async send<T>(message: Record<string, unknown>): Promise<T> {
      return await offscreenSendMock(message);
    }

    async ensureReadyWithRetry() {
      await ensureReadyMock();
    }

    async forceResetDocument() {}
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

describe('background test control plane', () => {
  let runtimeListener: ((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | void) | null = null;
  let persistedContextStore: PersistedContext | undefined;
  let sessionStore: Record<string, unknown>;

  const onMessageAddListenerMock = vi.fn();
  const onUpdatedAddListenerMock = vi.fn();
  const onInstalledAddListenerMock = vi.fn();
  const runtimeSendMessageMock = vi.fn((message: unknown) => {
    if (!runtimeListener) {
      return Promise.resolve(undefined);
    }

    return new Promise<unknown>((resolve) => {
      let responded = false;

      const sendResponse = (response?: unknown) => {
        responded = true;
        resolve(response);
      };

      const keepOpen = runtimeListener!(message, {} as chrome.runtime.MessageSender, sendResponse);
      if (keepOpen !== true && !responded) {
        resolve(undefined);
      }
    });
  });
  const tabsQueryMock = vi.fn(async () => {
    throw new Error('chrome.tabs.query should not be used when the test active-tab fixture is set');
  });
  const tabsCreateMock = vi.fn(async () => ({ id: 202 }));
  const tabsSendMessageMock = vi.fn(async () => true);
  const executeScriptMock = vi.fn(async () => undefined);
  const setBadgeTextMock = vi.fn();
  const setBadgeBackgroundColorMock = vi.fn();
  const tabCaptureGetMediaStreamIdMock = vi.fn((_options: unknown, callback: (streamId: string) => void) => {
    callback('stream-101');
  });

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

  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    delete (globalThis as { __JOT_TEST_CONTROL_PLANE_ENABLED__?: boolean }).__JOT_TEST_CONTROL_PLANE_ENABLED__;
    runtimeListener = null;
    persistedContextStore = undefined;
    sessionStore = {};

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
    onMessageAddListenerMock.mockReset();
    onUpdatedAddListenerMock.mockReset();
    onInstalledAddListenerMock.mockReset();
    runtimeSendMessageMock.mockClear();
    tabsQueryMock.mockReset();
    tabsCreateMock.mockReset();
    tabsSendMessageMock.mockReset();
    executeScriptMock.mockReset();
    setBadgeTextMock.mockReset();
    setBadgeBackgroundColorMock.mockReset();
    tabCaptureGetMediaStreamIdMock.mockReset();

    onMessageAddListenerMock.mockImplementation((listener: typeof runtimeListener) => {
      runtimeListener = listener;
    });
    onUpdatedAddListenerMock.mockImplementation(() => {});
    onInstalledAddListenerMock.mockImplementation(() => {});
    runtimeSendMessageMock.mockImplementation((message: unknown) => {
      if (!runtimeListener) {
        return Promise.resolve(undefined);
      }

      return new Promise<unknown>((resolve) => {
        let responded = false;
        const sendResponse = (response?: unknown) => {
          responded = true;
          resolve(response);
        };

        const keepOpen = runtimeListener!(message, {} as chrome.runtime.MessageSender, sendResponse);
        if (keepOpen !== true && !responded) {
          resolve(undefined);
        }
      });
    });
    tabsCreateMock.mockResolvedValue({ id: 202 });
    tabsSendMessageMock.mockResolvedValue(true);
    executeScriptMock.mockResolvedValue(undefined);
    tabCaptureGetMediaStreamIdMock.mockImplementation((_options: unknown, callback: (streamId: string) => void) => {
      callback('stream-101');
    });
    loadPersistedContextMock.mockImplementation(async () => persistedContextStore);
    savePersistedContextMock.mockImplementation(async (payload: PersistedContext) => {
      persistedContextStore = payload;
    });
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

    (globalThis as { defineBackground?: unknown }).defineBackground = (callback: () => void) => callback();
    Object.defineProperty(globalThis, 'navigator', {
      value: {
      storage: {
        session: {
          get: storageSessionGetMock,
          set: storageSessionSetMock,
          remove: storageSessionRemoveMock,
        },
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
        executeScript: executeScriptMock,
      },
      downloads: {
        download: downloadsDownloadMock,
      },
      storage: {
        session: {
          get: storageSessionGetMock,
          set: storageSessionSetMock,
          remove: storageSessionRemoveMock,
        },
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects test control plane messages when the gate is off', async () => {
    (globalThis as { __JOT_TEST_CONTROL_PLANE_ENABLED__?: boolean }).__JOT_TEST_CONTROL_PLANE_ENABLED__ = false;

    await bootBackground();

    const response = (await chrome.runtime.sendMessage({
      type: RuntimeMessageType.TEST_GET_SNAPSHOT,
    })) as { ok?: boolean; error?: string; snapshot?: { state?: string } };

    expect(response?.ok).toBe(false);
    expect(response?.error).toBe('Test control plane is disabled');
    expect(response?.snapshot?.state).toBe('idle');
  });

  it('returns snapshot and last filename readbacks from the background state', async () => {
    vi.useFakeTimers();
    try {
      const timestampMs = new Date(2026, 5, 29, 14, 30, 12).getTime();
      vi.setSystemTime(timestampMs);

      await bootBackground();

      const initialSnapshot = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.TEST_GET_SNAPSHOT,
      })) as { ok?: boolean; snapshot?: { state?: string; outputFileName?: string | null } };
      expect(initialSnapshot?.ok).toBe(true);
      expect(initialSnapshot?.snapshot?.state).toBe('idle');
      expect(initialSnapshot?.snapshot?.outputFileName).toBeNull();

      const initialFilename = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.TEST_GET_LAST_FILENAME,
      })) as { ok?: boolean; outputFileName?: string | null };
      expect(initialFilename?.ok).toBe(true);
      expect(initialFilename?.outputFileName).toBeNull();

      const activeTabResult = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.TEST_SET_ACTIVE_TAB,
        tab: {
          id: 101,
          title: 'ChatGPT - Google Chrome',
          url: 'https://chatgpt.com/chat',
        },
      })) as { ok?: boolean; activeTab?: { id: number } | null };
      expect(activeTabResult?.ok).toBe(true);
      expect(activeTabResult?.activeTab?.id).toBe(101);

      const preflight = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.PREPARE_START,
        includeMic: false,
        quality: 'auto',
      })) as { ok?: boolean };
      expect(preflight?.ok).toBe(true);

      const started = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.START,
        audioSource: 'tab',
        quality: 'auto',
      })) as { ok?: boolean; snapshot?: { state?: string; outputFileName?: string | null } };
      expect(started?.ok).toBe(true);
      expect(started?.snapshot?.state).toBe('recording');

      const expectedStem = buildExportBaseName({
        timestampMs,
        title: 'ChatGPT - Google Chrome',
        url: 'https://chatgpt.com/chat',
      });
      const expectedFilename = buildDownloadFileName(expectedStem, 'video/webm');

      expect(offscreenSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: RuntimeMessageType.OFFSCREEN_START_WEBCODECS,
          exportBaseName: expectedStem,
          recordingStartTime: timestampMs,
        }),
      );

      const inFlightFilename = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.TEST_GET_LAST_FILENAME,
      })) as { ok?: boolean; outputFileName?: string | null };
      expect(inFlightFilename?.ok).toBe(true);
      expect(inFlightFilename?.outputFileName).toBe(expectedFilename);

      const stopped = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.STOP,
      })) as { ok?: boolean };
      expect(stopped?.ok).toBe(true);

      const afterStopFilename = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.TEST_GET_LAST_FILENAME,
      })) as { ok?: boolean; outputFileName?: string | null };
      expect(afterStopFilename?.ok).toBe(true);
      expect(afterStopFilename?.outputFileName).toBe(expectedFilename);

      const savedContext = persistedContextStore;
      expect(savedContext?.outputFileName).toBe(expectedFilename);

      vi.resetModules();
      runtimeListener = null;
      (globalThis as { __JOT_TEST_CONTROL_PLANE_ENABLED__?: boolean }).__JOT_TEST_CONTROL_PLANE_ENABLED__ = true;
      await bootBackground();

      const rehydratedFilename = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.TEST_GET_LAST_FILENAME,
      })) as { ok?: boolean; outputFileName?: string | null };
      expect(rehydratedFilename?.ok).toBe(true);
      expect(rehydratedFilename?.outputFileName).toBe(expectedFilename);

      const rehydratedSnapshot = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.TEST_GET_SNAPSHOT,
      })) as { ok?: boolean; snapshot?: { state?: string; outputFileName?: string | null } };
      expect(rehydratedSnapshot?.ok).toBe(true);
      expect(rehydratedSnapshot?.snapshot?.outputFileName).toBe(expectedFilename);
      expect(rehydratedSnapshot?.snapshot?.state).toBe('recovery');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads, persists, and resets microphone permission fixtures through the control plane', async () => {
    await bootBackground();

    const initial = (await chrome.runtime.sendMessage({
      type: RuntimeMessageType.TEST_GET_PERMISSION_STATE,
    })) as {
      ok?: boolean;
      permissionState?: { microphone?: string };
      activeTab?: { id?: number } | null;
    };

    expect(initial?.ok).toBe(true);
    expect(initial?.permissionState?.microphone).toBe('unset');
    expect(initial?.activeTab).toBeNull();

    const setPermission = (await chrome.runtime.sendMessage({
      type: RuntimeMessageType.TEST_SET_PERMISSION_STATE,
      permissionState: {
        microphone: 'prompt',
      },
    })) as {
      ok?: boolean;
      permissionState?: { microphone?: string };
      activeTab?: { id?: number } | null;
    };

    expect(setPermission?.ok).toBe(true);
    expect(setPermission?.permissionState?.microphone).toBe('prompt');
    expect(setPermission?.activeTab).toBeNull();

    const setActiveTab = (await chrome.runtime.sendMessage({
      type: RuntimeMessageType.TEST_SET_ACTIVE_TAB,
      tab: {
        id: 101,
        title: 'Example Domain',
        url: 'https://example.com/',
      },
    })) as {
      ok?: boolean;
      activeTab?: { id?: number } | null;
    };

    expect(setActiveTab?.ok).toBe(true);
    expect(setActiveTab?.activeTab?.id).toBe(101);

    const afterSet = (await chrome.runtime.sendMessage({
      type: RuntimeMessageType.TEST_GET_PERMISSION_STATE,
    })) as {
      ok?: boolean;
      permissionState?: { microphone?: string };
      activeTab?: { id?: number; title?: string | null } | null;
    };

    expect(afterSet?.ok).toBe(true);
    expect(afterSet?.permissionState?.microphone).toBe('prompt');
    expect(afterSet?.activeTab?.id).toBe(101);

    vi.resetModules();
    runtimeListener = null;
    (globalThis as { __JOT_TEST_CONTROL_PLANE_ENABLED__?: boolean }).__JOT_TEST_CONTROL_PLANE_ENABLED__ = true;
    await bootBackground();

    const rehydrated = (await chrome.runtime.sendMessage({
      type: RuntimeMessageType.TEST_GET_PERMISSION_STATE,
    })) as {
      ok?: boolean;
      permissionState?: { microphone?: string };
      activeTab?: { id?: number } | null;
    };

    expect(rehydrated?.ok).toBe(true);
    expect(rehydrated?.permissionState?.microphone).toBe('prompt');
    expect(rehydrated?.activeTab).toBeNull();

    const reloadedActiveTab = (await chrome.runtime.sendMessage({
      type: RuntimeMessageType.TEST_SET_ACTIVE_TAB,
      tab: {
        id: 202,
        title: 'Google',
        url: 'https://google.com/',
      },
    })) as {
      ok?: boolean;
      activeTab?: { id?: number } | null;
    };

    expect(reloadedActiveTab?.ok).toBe(true);
    expect(reloadedActiveTab?.activeTab?.id).toBe(202);

    const reset = (await chrome.runtime.sendMessage({
      type: RuntimeMessageType.TEST_RESET_TEST_FIXTURES,
    })) as {
      ok?: boolean;
      permissionState?: { microphone?: string };
      activeTab?: { id?: number } | null;
    };

    expect(reset?.ok).toBe(true);
    expect(reset?.permissionState?.microphone).toBe('unset');
    expect(reset?.activeTab).toBeNull();

    const afterReset = (await chrome.runtime.sendMessage({
      type: RuntimeMessageType.TEST_GET_PERMISSION_STATE,
    })) as {
      ok?: boolean;
      permissionState?: { microphone?: string };
      activeTab?: { id?: number } | null;
    };

    expect(afterReset?.ok).toBe(true);
    expect(afterReset?.permissionState?.microphone).toBe('unset');
    expect(afterReset?.activeTab).toBeNull();
  });
});
