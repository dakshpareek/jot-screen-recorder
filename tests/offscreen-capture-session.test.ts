import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CaptureSession, type CaptureSessionDeps } from '@/entrypoints/offscreen/capture-session';

// ─── Fake MediaRecorder ────────────────────────────────────────────────────────

type RecorderEventHandler = ((event: Event) => void) | null;

interface FakeRecorder {
  state: 'inactive' | 'recording' | 'paused';
  mimeType: string;
  ondataavailable: RecorderEventHandler;
  onstop: RecorderEventHandler;
  onerror: RecorderEventHandler;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

function fakeRecorder(mimeType = 'video/webm'): FakeRecorder {
  const rec: FakeRecorder = {
    state: 'inactive' as const,
    mimeType,
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start: vi.fn(() => { rec.state = 'recording'; }),
    stop: vi.fn(() => { rec.state = 'inactive'; }),
    pause: vi.fn(() => { rec.state = 'paused'; }),
    resume: vi.fn(() => { rec.state = 'recording'; }),
  };
  return rec;
}

// Simulate MediaRecorder emitting one data chunk then stopping.
function triggerDataAndStop(rec: FakeRecorder, blobSize = 5000) {
  const blob = new Blob([new Uint8Array(blobSize)], { type: 'video/webm' });
  rec.ondataavailable?.({ data: blob } as unknown as Event);
  rec.onstop?.({} as Event);
}

// ─── Fake streams / audio ─────────────────────────────────────────────────────

function fakeTrack(kind: 'video' | 'audio' = 'video'): MediaStreamTrack {
  return {
    kind,
    readyState: 'live',
    stop: vi.fn(),
    label: `fake-${kind}-track`,
  } as unknown as MediaStreamTrack;
}

function fakeStream(videoCount = 1, audioCount = 0): MediaStream {
  const tracks: MediaStreamTrack[] = [
    ...Array.from({ length: videoCount }, () => fakeTrack('video')),
    ...Array.from({ length: audioCount }, () => fakeTrack('audio')),
  ];
  return {
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getTracks: () => tracks,
    addTrack: vi.fn(),
  } as unknown as MediaStream;
}

function fakeAudioContext() {
  const analyser = {
    frequencyBinCount: 4,
    getByteFrequencyData: vi.fn((data: Uint8Array) => data.fill(0)),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    createAnalyser: vi.fn(() => analyser),
    createMediaStreamSource: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createMediaStreamDestination: vi.fn(() => ({
      stream: fakeStream(0, 1),
    })),
    createGain: vi.fn(() => ({
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

// ─── Fake OPFS port ───────────────────────────────────────────────────────────

function fakeOpfs() {
  return {
    writeChunk: vi.fn(async () => {}),
    writeManifest: vi.fn(async () => {}),
    writeWebCodecsRange: vi.fn(async () => {}),
  };
}

// ─── Fake WebCodecs pipeline ──────────────────────────────────────────────────

function fakeWebCodecsPipeline() {
  const pipeline = {
    _running: false,
    isRunning: vi.fn(() => pipeline._running),
    start: vi.fn(async () => { pipeline._running = true; }),
    stop: vi.fn(async () => {
      pipeline._running = false;
      return new ArrayBuffer(5000);
    }),
    getStats: vi.fn(() => ({
      framesEncoded: 300,
      bytesWritten: 5000,
      droppedFrames: 0,
      hardwareAccelerated: false,
      memoryPressureTier: 0,
      videoBitrateBps: 1_000_000,
      outputMimeType: 'video/mp4',
    })),
    checkCapabilities: vi.fn(async () => ({
      videoSupported: true,
      audioSupported: true,
      hardwareAcceleration: false,
      fallbackReason: null,
    })),
  };
  return pipeline;
}

// ─── Fake timer helpers ───────────────────────────────────────────────────────

function fakeTimers() {
  let seq = 1;
  const pending = new Map<number, { cb: () => void; ms: number; recurring: boolean }>();

  const setTimeout_ = vi.fn((cb: () => void, ms: number) => {
    const id = seq++;
    pending.set(id, { cb, ms, recurring: false });
    return id;
  });
  const clearTimeout_ = vi.fn((id: number | null | undefined) => {
    if (id != null) pending.delete(id);
  });
  const setInterval_ = vi.fn((cb: () => void, ms: number) => {
    const id = seq++;
    pending.set(id, { cb, ms, recurring: true });
    return id;
  });
  const clearInterval_ = vi.fn((id: number | null | undefined) => {
    if (id != null) pending.delete(id);
  });

  const flush = (targetId?: number) => {
    for (const [id, entry] of [...pending]) {
      if (targetId != null && id !== targetId) continue;
      entry.cb();
      if (!entry.recurring) pending.delete(id);
    }
  };

  return { setTimeout: setTimeout_, clearTimeout: clearTimeout_, setInterval: setInterval_, clearInterval: clearInterval_, flush, pending };
}

// ─── createDeps factory ───────────────────────────────────────────────────────

function createDeps(
  overrides: Partial<CaptureSessionDeps> = {},
  options: { recorder?: FakeRecorder } = {},
): CaptureSessionDeps {
  const timers = fakeTimers();
  const rec = options.recorder ?? fakeRecorder();
  let urlSeq = 0;

  return {
    opfs: fakeOpfs(),
    getUserMedia: vi.fn(async () => fakeStream(1, 1)),
    createAudioContext: vi.fn(() => fakeAudioContext() as unknown as AudioContext),
    createMediaRecorder: vi.fn(() => rec as unknown as MediaRecorder),
    isMimeTypeSupported: vi.fn(() => false),
    estimateStorage: vi.fn(async () => ({ quota: 10_000_000_000, usage: 1_000_000 })),
    createMediaStream: vi.fn((tracks?: MediaStreamTrack[]) => fakeStream(
      tracks?.filter((t) => t.kind === 'video').length ?? 0,
      tracks?.filter((t) => t.kind === 'audio').length ?? 0,
    )),
    createWebCodecsPipeline: vi.fn(() => fakeWebCodecsPipeline() as unknown as import('@/entrypoints/offscreen/webcodecs').WebCodecsPipeline),
    createSyntheticStream: vi.fn(() => ({ stream: fakeStream(1), cleanup: vi.fn() })),
    sendRuntimeMessage: vi.fn(async () => {}),
    resolveMicPermissionState: vi.fn(async () => 'granted' as PermissionState),
    adoptOutput: vi.fn(() => `blob:out-${urlSeq++}`),
    sha256: vi.fn(async () => 'cafebabe'),
    createObjectURL: vi.fn(() => `blob:url-${urlSeq++}`),
    revokeObjectURL: vi.fn(),
    probeVideoDuration: vi.fn(async () => 5.0),
    now: vi.fn(() => 1_000_000),
    // Fire immediately so async wait() calls in runMicPreflight don't hang.
    // Stop-flush tests override this with their own spy.
    setTimeout: vi.fn((cb: () => void, _ms: number) => { cb(); return 1; }),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    ...overrides,
  };
}

// Helper to get the timer flush function from the deps
function getTimerFlush(deps: CaptureSessionDeps): (id?: number) => void {
  // Access the flush helper stored on the vi.fn mock
  return (deps.setTimeout as unknown as { _flush: (id?: number) => void })._flush;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CaptureSession.startRecording', () => {
  it('returns error when recorder is already active', async () => {
    const rec = fakeRecorder();
    const deps = createDeps({}, { recorder: rec });
    const session = new CaptureSession(deps);
    // Prime the recorder state
    await session.startRecording('s1', 'stream-1', 'tab', null, 'auto');
    // Mark it as recording
    (rec as FakeRecorder).state = 'recording';

    const result = await session.startRecording('s2', 'stream-2', 'tab', null, 'auto');
    expect(result).toEqual({ ok: false, error: 'Recorder is already active' });
  });

  it('returns error when stream id is empty', async () => {
    const session = new CaptureSession(createDeps());
    const result = await session.startRecording('sess', '', 'tab', null, 'auto');
    expect(result).toEqual({ ok: false, error: 'Missing tab stream id' });
  });

  it('starts recording and writes manifest', async () => {
    const rec = fakeRecorder('video/webm');
    const deps = createDeps({}, { recorder: rec });
    const session = new CaptureSession(deps);

    const result = await session.startRecording('sess-1', 'stream-abc', 'tab', null, 'auto');
    expect(result.ok).toBe(true);
    expect(result.outputMimeType).toBeDefined();
    expect(deps.opfs.writeManifest).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      sessionId: 'sess-1',
      status: 'recording',
    }));
    expect(rec.start).toHaveBeenCalled();
  });

  it('reports status correctly during recording', async () => {
    const rec = fakeRecorder();
    const deps = createDeps({}, { recorder: rec });
    const session = new CaptureSession(deps);

    await session.startRecording('sess-1', 'stream-abc', 'tab', null, 'auto');
    rec.state = 'recording';

    const status = session.getStatus();
    expect(status.isRecording).toBe(true);
    expect(status.sessionId).toBe('sess-1');
  });

  it('uses synthetic stream for test stream ids', async () => {
    const cleanup = vi.fn();
    const syntheticStream = fakeStream(1);
    const deps = createDeps({
      createSyntheticStream: vi.fn(() => ({ stream: syntheticStream, cleanup })),
    });
    const session = new CaptureSession(deps);

    // jot-test-capture: prefix triggers isTestCaptureStreamId
    await session.startRecording('sess', 'jot-test-capture:42', 'tab', null, 'auto');
    expect(deps.createSyntheticStream).toHaveBeenCalled();
  });
});

describe('CaptureSession.stopRecording', () => {
  it('returns error when recorder is inactive', async () => {
    const session = new CaptureSession(createDeps());
    const result = await session.stopRecording();
    expect(result).toEqual({ ok: false, error: 'Recorder is not active' });
  });

  it('stop-flush barrier: resolves after final dataavailable fires', async () => {
    const rec = fakeRecorder('video/webm');
    let resolveTimeout!: () => void;
    const timers = fakeTimers();

    // Override setTimeout so we can manually fire the 1500ms timeout
    const setTimeoutSpy = vi.fn((cb: () => void, _ms: number) => {
      resolveTimeout = cb;
      return timers.setTimeout(cb, _ms);
    });

    const deps = createDeps(
      {
        setTimeout: setTimeoutSpy as unknown as CaptureSessionDeps['setTimeout'],
        clearTimeout: timers.clearTimeout,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
      },
      { recorder: rec },
    );
    const session = new CaptureSession(deps);
    await session.startRecording('sess', 'stream-x', 'tab', null, 'auto');
    rec.state = 'recording';

    // Start stop (async — don't await yet)
    const stopPromise = session.stopRecording();

    // Simulate dataavailable arriving before timeout
    const blob = new Blob([new Uint8Array(5000)], { type: 'video/webm' });
    rec.ondataavailable?.({ data: blob } as unknown as Event);

    // Then fire onstop
    rec.onstop?.({} as Event);

    const result = await stopPromise;
    expect(result.ok).toBe(true);
    expect(deps.opfs.writeChunk).toHaveBeenCalled();
    expect(deps.opfs.writeManifest).toHaveBeenCalledWith(
      'sess',
      expect.objectContaining({ status: 'complete' }),
    );
  });

  it('stop-flush barrier: 1.5s timeout fallback resolves even without dataavailable', async () => {
    const rec = fakeRecorder('video/webm');
    const timers = fakeTimers();
    let stopTimeoutCb: (() => void) | null = null;

    const setTimeoutSpy = vi.fn((cb: () => void, ms: number) => {
      if (ms === 1_500) stopTimeoutCb = cb;
      return timers.setTimeout(cb, ms);
    });

    const deps = createDeps(
      {
        setTimeout: setTimeoutSpy as unknown as CaptureSessionDeps['setTimeout'],
        clearTimeout: timers.clearTimeout,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
      },
      { recorder: rec },
    );
    const session = new CaptureSession(deps);
    await session.startRecording('sess', 'stream-x', 'tab', null, 'auto');
    rec.state = 'recording';

    const stopPromise = session.stopRecording();

    // Fire the 1.5s timeout (no dataavailable came)
    (stopTimeoutCb as (() => void) | null)?.();
    // Then fire onstop
    rec.onstop?.({} as Event);

    const result = await stopPromise;
    expect(result.ok).toBe(true);
  });
});

describe('CaptureSession.pauseRecording / resumeRecording', () => {
  it('pause fails when not recording', async () => {
    const session = new CaptureSession(createDeps());
    expect(await session.pauseRecording()).toEqual({
      ok: false,
      error: 'Recorder is not actively recording',
    });
  });

  it('resume fails when not paused', async () => {
    const session = new CaptureSession(createDeps());
    expect(await session.resumeRecording()).toEqual({
      ok: false,
      error: 'Recorder is not paused',
    });
  });

  it('pause → resume cycle calls MediaRecorder methods', async () => {
    const rec = fakeRecorder();
    const deps = createDeps({}, { recorder: rec });
    const session = new CaptureSession(deps);
    await session.startRecording('sess', 'stream-x', 'tab', null, 'auto');
    rec.state = 'recording';

    await session.pauseRecording();
    expect(rec.pause).toHaveBeenCalled();

    await session.resumeRecording();
    expect(rec.resume).toHaveBeenCalled();
  });
});

describe('CaptureSession.forceCleanupCapture', () => {
  it('resets state and returns ok', async () => {
    const rec = fakeRecorder();
    const deps = createDeps({}, { recorder: rec });
    const session = new CaptureSession(deps);
    await session.startRecording('sess', 'stream-x', 'tab', null, 'auto');

    const result = await session.forceCleanupCapture();
    expect(result.ok).toBe(true);
    expect(session.getStatus().sessionId).toBeNull();
  });
});

describe('CaptureSession buildCaptureStream — mic-mix fallback', () => {
  it('emits MIC_MIX_FAILED and falls back to tab-only when AudioContext creation fails', async () => {
    const rec = fakeRecorder();
    const sendRuntimeMessage = vi.fn(async () => {});
    const deps = createDeps(
      {
        createAudioContext: vi.fn(() => {
          throw new Error('AudioContext unavailable');
        }),
        sendRuntimeMessage,
        // mic track available so getUserMedia returns audio
        getUserMedia: vi.fn(async () => fakeStream(1, 1)),
      },
      { recorder: rec },
    );
    const session = new CaptureSession(deps);
    const result = await session.startRecording('sess', 'stream-x', 'both', null, 'auto');
    // Should have started despite the mix failure (tab-only fallback)
    expect(result.ok).toBe(true);
    const allCalls = sendRuntimeMessage.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const micMixCall = allCalls.find((call) => call[0]?.type === 'MIC_MIX_FAILED');
    expect(micMixCall).toBeDefined();
  });
});

describe('CaptureSession.runMicPreflight', () => {
  it('returns MIC_PERMISSION_DENIED when state is denied', async () => {
    const deps = createDeps({
      resolveMicPermissionState: vi.fn(async () => 'denied' as PermissionState),
    });
    const result = await new CaptureSession(deps).runMicPreflight(null, null);
    expect(result).toEqual({ ok: false, error: 'MIC_PERMISSION_DENIED' });
  });

  it('skips permission check when permissionState is pre-supplied as granted', async () => {
    const deps = createDeps({
      // Shouldn't be called at all when caller pre-supplies state
      resolveMicPermissionState: vi.fn(async () => 'denied' as PermissionState),
    });
    // Pass 'granted' explicitly → should skip the browser query and try getUserMedia
    const result = await new CaptureSession(deps).runMicPreflight(null, 'granted');
    // getUserMedia fakes a valid stream so we expect ok:true
    expect(result.ok).toBe(true);
  });
});

describe('CaptureSession WebCodecs', () => {
  it('handleCheckWebCodecsSupport returns ok:false when VideoEncoder is undefined', async () => {
    // In node test env VideoEncoder is not defined
    const session = new CaptureSession(createDeps());
    const result = await session.handleCheckWebCodecsSupport('auto');
    expect(result.ok).toBe(false);
    // Either the explicit not-available message or a format-resolve failure
    expect(typeof result.error).toBe('string');
  });

  it('chunk count increments per dataavailable event', async () => {
    const rec = fakeRecorder();
    const deps = createDeps({}, { recorder: rec });
    const session = new CaptureSession(deps);
    await session.startRecording('sess', 'stream-x', 'tab', null, 'auto');
    rec.state = 'recording';

    // Fire two chunks
    const blob = new Blob([new Uint8Array(5000)], { type: 'video/webm' });
    rec.ondataavailable?.({ data: blob } as unknown as Event);
    rec.ondataavailable?.({ data: blob } as unknown as Event);

    // Allow write queue to drain
    await new Promise((r) => setImmediate(r));

    expect(session.getStatus().chunkCount).toBe(2);
    expect(deps.opfs.writeChunk).toHaveBeenCalledTimes(2);
  });
});
