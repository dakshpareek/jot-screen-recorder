import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AUDIO_PREFLIGHT,
  RecordingSession,
  type RecordingSessionDeps,
} from '@/entrypoints/background/recording-session';
import type { PersistedContext } from '@/entrypoints/background/state/persisted-context';

function createFakeDeps(overrides: Partial<RecordingSessionDeps> = {}): RecordingSessionDeps {
  return {
    offscreen: {
      send: vi.fn(async () => ({ ok: true }) as never),
      ensureReadyWithRetry: vi.fn(async () => {}),
      forceResetDocument: vi.fn(async () => {}),
      markReady: vi.fn(),
    },
    delay: vi.fn(async () => {}),
    persist: vi.fn(async () => {}),
    broadcast: vi.fn(async () => {}),
    setBadge: vi.fn(),
    showRecordingBanner: vi.fn(async () => {}),
    hideRecordingBanner: vi.fn(async () => {}),
    loadRecorderSettings: vi.fn(async () => ({ encoderBackend: 'webcodecs' as const })),
    estimateStorage: vi.fn(async () => ({ quota: 10_000_000_000, usage: 100_000_000 })),
    resolveMicPermissionState: vi.fn(async () => 'granted' as PermissionState),
    isTestControlPlaneEnabled: vi.fn(() => false),
    getTestActiveTabFixture: vi.fn(async () => null),
    queryActiveTab: vi.fn(async () => ({ id: 101 }) as chrome.tabs.Tab),
    activateTab: vi.fn(async () => {}),
    getCaptureStreamId: vi.fn(async () => 'stream-101'),
    getCapturedTabInfo: vi.fn(async () => null),
    download: vi.fn(async () => 1),
    ...overrides,
  };
}

function buildPersistedContext(overrides: Partial<PersistedContext> = {}): PersistedContext {
  return {
    state: 'idle',
    sessionId: null,
    recordingStartTime: null,
    chunkCount: 0,
    processingProgress: null,
    errorMessage: null,
    micWarningMessage: null,
    storageWarningMessage: null,
    outputFileName: null,
    requestedPreset: 'auto',
    resolvedPreset: null,
    recordingQuality: 'auto',
    validation: null,
    processingMetrics: null,
    audioPreflight: { ...DEFAULT_AUDIO_PREFLIGHT },
    orphanedSessions: [],
    recoverySessionId: null,
    recoveryChunks: [],
    webCodecsStats: null,
    ...overrides,
  };
}

describe('RecordingSession', () => {
  let deps: RecordingSessionDeps;

  beforeEach(() => {
    deps = createFakeDeps();
  });

  it('exposes a default idle snapshot', () => {
    const session = new RecordingSession(deps);
    const snapshot = session.snapshot();

    expect(snapshot.state).toBe('idle');
    expect(snapshot.canDownload).toBe(false);
    expect(snapshot.requestedPreset).toBe('auto');
    expect(snapshot.audioPreflight).toEqual(DEFAULT_AUDIO_PREFLIGHT);
  });

  it('round-trips hydrate → toPersisted for a stored context', () => {
    const stored = buildPersistedContext({
      sessionId: 'sess-1',
      chunkCount: 4,
      errorMessage: 'prior error',
      orphanedSessions: [{ sessionId: 'orph-1', startTime: 1, chunkCount: 2, totalSize: 9 }],
      requestedPreset: '1080p60',
      recordingQuality: '1080p60',
      resolvedPreset: '1080p30',
    });

    const session = new RecordingSession(deps);
    session.hydrate(stored);

    const persisted = session.toPersisted();
    expect(persisted.sessionId).toBe('sess-1');
    expect(persisted.chunkCount).toBe(4);
    expect(persisted.errorMessage).toBe('prior error');
    expect(persisted.orphanedSessions).toEqual(stored.orphanedSessions);
    expect(persisted.state).toBe('idle');
    // usingWebCodecs is intentionally never persisted (legacy behavior).
    expect('usingWebCodecs' in persisted).toBe(false);
  });

  it('forces done → recovery on hydrate and surfaces the reprocess message', () => {
    const session = new RecordingSession(deps);
    session.hydrate(buildPersistedContext({ state: 'done', sessionId: 'sess-done' }));

    const snapshot = session.snapshot();
    expect(snapshot.state).toBe('recovery');
    expect(snapshot.errorMessage).toBe('Output must be reprocessed before download.');
  });

  it('normalizes a missing audio preflight to the default on hydrate', () => {
    const session = new RecordingSession(deps);
    session.hydrate(
      buildPersistedContext({
        audioPreflight: undefined as unknown as PersistedContext['audioPreflight'],
      }),
    );

    expect(session.snapshot().audioPreflight).toEqual(DEFAULT_AUDIO_PREFLIGHT);
  });

  it('fans out badge/persist/broadcast on a forced state change', () => {
    const session = new RecordingSession(deps);
    session.hydrate(buildPersistedContext({ state: 'idle' }));
    vi.clearAllMocks();

    // idle → preflight is an allowed transition.
    session.hydrate(buildPersistedContext({ state: 'preflight' }));

    expect(deps.setBadge).toHaveBeenCalledWith('preflight');
    expect(deps.persist).toHaveBeenCalled();
    expect(deps.broadcast).toHaveBeenCalled();
    expect(session.snapshot().state).toBe('preflight');
  });

  it('marks hydration failure as the error state', () => {
    const session = new RecordingSession(deps);
    session.failHydration(new Error('storage exploded'));

    const snapshot = session.snapshot();
    expect(snapshot.state).toBe('error');
    expect(snapshot.errorMessage).toBe('storage exploded');
  });
});

describe('RecordingSession lifecycle', () => {
  function offscreenRouter(
    handlers: Record<string, (message: { type?: string; [key: string]: unknown }) => unknown>,
  ) {
    return vi.fn(async (message: { type?: string }) => {
      const handler = message.type ? handlers[message.type] : undefined;
      return (handler ? handler(message) : { ok: true }) as never;
    });
  }

  it('drives prepareStart → start → stop → download against fakes (WebCodecs path)', async () => {
    const send = offscreenRouter({
      OFFSCREEN_SCAN_ORPHANS: () => ({ ok: true, sessions: [] }),
      OFFSCREEN_START_WEBCODECS: () => ({
        ok: true,
        requestedPreset: 'auto',
        resolvedPreset: '1080p30',
        outputMimeType: 'video/webm',
      }),
      OFFSCREEN_STOP_WEBCODECS: () => ({
        ok: true,
        outputUrl: 'blob:webcodecs',
        outputMimeType: 'video/webm',
      }),
    });
    const deps = createFakeDeps({
      offscreen: {
        send,
        ensureReadyWithRetry: vi.fn(async () => {}),
        forceResetDocument: vi.fn(async () => {}),
        markReady: vi.fn(),
      },
    });
    const session = new RecordingSession(deps);

    const prep = await session.prepareStart(false, null, 'auto');
    expect(prep.ok).toBe(true);
    expect(session.snapshot().state).toBe('armed');

    const start = await session.start('tab', null, 'auto');
    expect(start.ok).toBe(true);
    expect(session.snapshot().state).toBe('recording');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OFFSCREEN_START_WEBCODECS' }),
    );

    const stop = await session.stop();
    expect(stop.ok).toBe(true);
    expect(session.snapshot().state).toBe('done');
    expect(session.snapshot().canDownload).toBe(true);

    const download = await session.download();
    expect(download.ok).toBe(true);
    expect(deps.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: expect.any(String), saveAs: true }),
    );
    expect(session.snapshot().state).toBe('idle');
  });

  it('blocks start and stop from invalid states', async () => {
    const session = new RecordingSession(createFakeDeps());

    const start = await session.start('tab', null, 'auto');
    expect(start.ok).toBe(false);
    expect(start.error).toContain('Cannot start from state "idle"');

    const stop = await session.stop();
    expect(stop.ok).toBe(false);
    expect(stop.error).toContain('Cannot stop from state "idle"');
  });

  it('discards an orphaned session through the offscreen port', async () => {
    const send = offscreenRouter({
      OFFSCREEN_CLEAR_SESSION: () => ({ ok: true }),
      OFFSCREEN_SCAN_ORPHANS: () => ({ ok: true, sessions: [] }),
    });
    const deps = createFakeDeps({
      offscreen: {
        send,
        ensureReadyWithRetry: vi.fn(async () => {}),
        forceResetDocument: vi.fn(async () => {}),
        markReady: vi.fn(),
      },
    });
    const session = new RecordingSession(deps);

    const result = await session.discardOrphan('orphan-1');
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OFFSCREEN_CLEAR_SESSION', sessionId: 'orphan-1' }),
    );
  });
});
