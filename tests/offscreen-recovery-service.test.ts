import { describe, expect, it, vi } from 'vitest';
import {
  RecoveryService,
  type RecoveryServiceDeps,
} from '@/entrypoints/offscreen/recovery/recovery-service';
import type { SessionManifest } from '@/entrypoints/offscreen/types';

function manifest(overrides: Partial<SessionManifest> = {}): SessionManifest {
  return {
    sessionId: 'sess-1',
    startTime: 1,
    recordingQuality: '1080p30',
    recordingResolvedQuality: '1080p30',
    mimeType: 'video/webm',
    chunks: [],
    totalDuration: 0,
    status: 'recording',
    ...overrides,
  };
}

function createDeps(overrides: Partial<RecoveryServiceDeps> = {}): RecoveryServiceDeps {
  let urlSeq = 0;
  return {
    opfs: {
      readManifest: vi.fn(async () => manifest()),
      readChunk: vi.fn(async () => new ArrayBuffer(2048)),
      readWebCodecsStream: vi.fn(async () => new ArrayBuffer(4096)),
      writeManifest: vi.fn(async () => {}),
      scanOrphans: vi.fn(async () => []),
      clearSession: vi.fn(async () => {}),
    },
    sha256: vi.fn(async () => 'deadbeef'),
    createObjectURL: vi.fn(() => `blob:url-${urlSeq++}`),
    revokeObjectURL: vi.fn(),
    ...overrides,
  };
}

describe('RecoveryService', () => {
  it('clears a session through the opfs port', async () => {
    const deps = createDeps();
    const svc = new RecoveryService(deps);

    expect(await svc.clearSessionData('orphan-1')).toEqual({ ok: true });
    expect(deps.opfs.clearSession).toHaveBeenCalledWith('orphan-1');

    expect(await svc.clearSessionData('')).toEqual({ ok: false, error: 'Missing session id' });
  });

  it('seeds orphan manifests and returns the rescanned list', async () => {
    const deps = createDeps();
    const svc = new RecoveryService(deps);

    const result = await svc.seedOrphanedSessions([
      { sessionId: 'orph-1', startTime: 5, chunkCount: 0 } as never,
    ]);

    expect(result.ok).toBe(true);
    expect(deps.opfs.writeManifest).toHaveBeenCalledWith(
      'orph-1',
      expect.objectContaining({ sessionId: 'orph-1', recordingKind: 'webcodecs-opfs' }),
    );
    expect(deps.opfs.scanOrphans).toHaveBeenCalled();
  });

  it('inspects a webcodecs-opfs session as a single ok chunk', async () => {
    const deps = createDeps({
      opfs: {
        ...createDeps().opfs,
        readManifest: vi.fn(async () => manifest({ recordingKind: 'webcodecs-opfs' })),
        readWebCodecsStream: vi.fn(async () => new ArrayBuffer(5000)),
      },
    });
    const svc = new RecoveryService(deps);

    const result = await svc.inspectRecoveryChunks('sess-1');
    expect(result.ok).toBe(true);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks?.[0]).toMatchObject({ index: 0, status: 'ok', included: true });
  });

  it('marks a webcodecs-opfs session missing when the stream read fails', async () => {
    const deps = createDeps({
      opfs: {
        ...createDeps().opfs,
        readManifest: vi.fn(async () => manifest({ recordingKind: 'webcodecs-opfs' })),
        readWebCodecsStream: vi.fn(async () => {
          throw new Error('not found');
        }),
      },
    });
    const svc = new RecoveryService(deps);

    const result = await svc.inspectRecoveryChunks('sess-1');
    expect(result.chunks?.[0]).toMatchObject({ status: 'missing', included: false });
  });

  it('classifies chunk checksums as ok / suspect / missing', async () => {
    const deps = createDeps({
      sha256: vi.fn(async () => 'match'),
      opfs: {
        ...createDeps().opfs,
        readManifest: vi.fn(async () =>
          manifest({
            chunks: [
              { index: 0, size: 10, written: true, duration: 10, checksum: 'match' },
              { index: 1, size: 10, written: true, duration: 10, checksum: 'different' },
              { index: 2, size: 10, written: true, duration: 10, checksum: 'x' },
            ],
          }),
        ),
        readChunk: vi.fn(async (_sid: string, index: number) => {
          if (index === 2) throw new Error('gone');
          return new ArrayBuffer(10);
        }),
      },
    });
    const svc = new RecoveryService(deps);

    const result = await svc.inspectRecoveryChunks('sess-1');
    expect(result.chunks?.map((c) => c.status)).toEqual(['ok', 'suspect', 'missing']);
    expect(result.chunks?.map((c) => c.included)).toEqual([true, true, false]);
  });

  it('builds a raw-export item list for a chunked session', async () => {
    const deps = createDeps({
      opfs: {
        ...createDeps().opfs,
        readManifest: vi.fn(async () =>
          manifest({
            mimeType: 'video/mp4',
            chunks: [
              { index: 0, size: 10, written: true, duration: 10, checksum: 'a' },
              { index: 1, size: 10, written: true, duration: 10, checksum: 'b' },
            ],
          }),
        ),
      },
    });
    const svc = new RecoveryService(deps);

    const result = await svc.downloadRawChunks('sess-1');
    expect(result.ok).toBe(true);
    // manifest.json + 2 chunks
    expect(result.items).toHaveLength(3);
    expect(result.items?.[0].filename).toMatch(/manifest\.json$/);
    expect(result.items?.[1].filename).toMatch(/chunk-0\.mp4$/);
    expect(deps.createObjectURL).toHaveBeenCalledTimes(3);
  });

  it('errors raw export when the session has no chunks', async () => {
    const deps = createDeps();
    const svc = new RecoveryService(deps);
    expect(await svc.downloadRawChunks('sess-1')).toEqual({
      ok: false,
      error: 'No chunks found for this session',
    });
  });
});
