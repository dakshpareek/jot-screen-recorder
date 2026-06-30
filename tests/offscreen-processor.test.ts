import { describe, expect, it, vi } from 'vitest';
import { Processor, type ProcessorDeps } from '@/entrypoints/offscreen/processing/processor';
import type { FFmpegClass, SessionManifest } from '@/entrypoints/offscreen/types';

function manifest(overrides: Partial<SessionManifest> = {}): SessionManifest {
  return {
    sessionId: 'sess-1',
    startTime: 1,
    recordingQuality: '1080p30',
    recordingResolvedQuality: '1080p30',
    mimeType: 'video/webm',
    chunks: [],
    totalDuration: 0,
    status: 'complete',
    ...overrides,
  };
}

/** Uint8Array whose bytes 4..7 spell "ftyp" so hasMp4FtypHeader passes. */
function mp4Bytes(size: number): Uint8Array {
  const buf = new Uint8Array(Math.max(size, 12));
  buf[4] = 0x66;
  buf[5] = 0x74;
  buf[6] = 0x79;
  buf[7] = 0x70;
  return buf;
}

/** ftyp-tagged ArrayBuffer of the given size. */
function mp4Buffer(size: number): ArrayBuffer {
  return mp4Bytes(size).buffer.slice(0) as ArrayBuffer;
}

function fakeFFmpeg(readFileImpl?: (name: string) => unknown) {
  const inst = {
    on: vi.fn(),
    load: vi.fn(async () => {}),
    exec: vi.fn(async (_args: string[]) => {}),
    writeFile: vi.fn(async (_name: string, _data: unknown) => {}),
    readFile: vi.fn(async (name: string): Promise<unknown> =>
      readFileImpl ? readFileImpl(name) : mp4Bytes(1_100_000),
    ),
    deleteFile: vi.fn(async (_name: string) => {}),
    ffprobe: vi.fn(async (_args: string[]) => 0),
  };
  const ctor = function FakeFFmpeg() {
    return inst;
  } as unknown as FFmpegClass;
  return { inst, ctor };
}

function createDeps(overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
  let urlSeq = 0;
  return {
    opfs: {
      readManifest: vi.fn(async () => manifest()),
      readChunk: vi.fn(async () => mp4Buffer(100_000)),
      readWebCodecsStream: vi.fn(async () => mp4Buffer(100_000)),
    },
    emit: vi.fn(async () => {}),
    createObjectURL: vi.fn(() => `blob:out-${urlSeq++}`),
    revokeObjectURL: vi.fn(),
    probeVideoDuration: vi.fn(async () => 0),
    importFFmpegCtor: vi.fn(async () => fakeFFmpeg().ctor),
    ffmpegLoadConfig: { classWorkerURL: 'w', coreURL: 'c', wasmURL: 'a' },
    isRecorderActive: vi.fn(() => false),
    chunkDurationSeconds: 10,
    ...overrides,
  };
}

describe('Processor', () => {
  it('rejects processing while the recorder is active', async () => {
    const deps = createDeps({ isRecorderActive: () => true });
    const result = await new Processor(deps).processRecording('sess-1');
    expect(result).toEqual({ ok: false, error: 'Cannot process while recorder is active' });
  });

  it('errors on missing session id and missing chunks', async () => {
    const proc = new Processor(createDeps());
    expect(await proc.processRecording('')).toEqual({ ok: false, error: 'Missing session id' });
    expect(await proc.processRecording('sess-1')).toEqual({
      ok: false,
      error: 'No chunks found for this session',
    });
  });

  it('single-copies a webcodecs-opfs stream without invoking ffmpeg', async () => {
    const importFFmpegCtor = vi.fn(async () => fakeFFmpeg().ctor);
    const deps = createDeps({
      importFFmpegCtor,
      opfs: {
        readManifest: vi.fn(async () => manifest({ recordingKind: 'webcodecs-opfs', mimeType: 'video/mp4' })),
        readChunk: vi.fn(async () => mp4Buffer(10)),
        readWebCodecsStream: vi.fn(async () => mp4Buffer(1_100_000)),
      },
    });
    const proc = new Processor(deps);

    const result = await proc.processRecording('sess-1');
    expect(result.ok).toBe(true);
    expect(result.outputMimeType).toBe('video/mp4');
    expect(result.outputUrl).toMatch(/^blob:/);
    expect(importFFmpegCtor).not.toHaveBeenCalled();
    expect(proc.outputBlob).not.toBeNull();
  });

  it('fast-copies a single mp4 chunk without ffmpeg', async () => {
    const importFFmpegCtor = vi.fn(async () => fakeFFmpeg().ctor);
    const deps = createDeps({
      importFFmpegCtor,
      opfs: {
        readManifest: vi.fn(async () =>
          manifest({
            mimeType: 'video/mp4',
            chunks: [{ index: 0, size: 10, written: true, duration: 10, checksum: 'a' }],
          }),
        ),
        readChunk: vi.fn(async () => mp4Buffer(1_100_000)),
        readWebCodecsStream: vi.fn(async () => mp4Buffer(10)),
      },
    });
    const proc = new Processor(deps);

    const result = await proc.processRecording('sess-1');
    expect(result.ok).toBe(true);
    expect(result.outputMimeType).toBe('video/mp4');
    expect(importFFmpegCtor).not.toHaveBeenCalled();
  });

  it('transcodes a single webm chunk through ffmpeg (single-input args)', async () => {
    const { inst, ctor } = fakeFFmpeg();
    const deps = createDeps({
      importFFmpegCtor: vi.fn(async () => ctor),
      opfs: {
        readManifest: vi.fn(async () =>
          manifest({
            mimeType: 'video/webm',
            chunks: [{ index: 0, size: 10, written: true, duration: 10, checksum: 'a' }],
          }),
        ),
        readChunk: vi.fn(async () => new ArrayBuffer(100)), // non-mp4 -> no fast copy
        readWebCodecsStream: vi.fn(async () => new ArrayBuffer(0)),
      },
    });
    const proc = new Processor(deps);

    const result = await proc.processRecording('sess-1');
    expect(result.ok).toBe(true);
    expect(inst.writeFile).toHaveBeenCalledWith('input.webm', expect.anything());
    const execArgs = inst.exec.mock.calls[0][0] as string[];
    expect(execArgs.slice(0, 2)).toEqual(['-i', 'input.webm']);
    expect(execArgs).not.toContain('concat');
  });

  it('concats multiple mp4 chunks through the concat demuxer', async () => {
    const { inst, ctor } = fakeFFmpeg();
    const deps = createDeps({
      importFFmpegCtor: vi.fn(async () => ctor),
      opfs: {
        readManifest: vi.fn(async () =>
          manifest({
            mimeType: 'video/mp4',
            chunks: [
              { index: 0, size: 10, written: true, duration: 10, checksum: 'a' },
              { index: 1, size: 10, written: true, duration: 10, checksum: 'b' },
            ],
          }),
        ),
        readChunk: vi.fn(async () => new ArrayBuffer(100)),
        readWebCodecsStream: vi.fn(async () => new ArrayBuffer(0)),
      },
    });
    const proc = new Processor(deps);

    const result = await proc.processRecording('sess-1');
    expect(result.ok).toBe(true);
    expect(inst.writeFile).toHaveBeenCalledWith('list.txt', expect.anything());
    const execArgs = inst.exec.mock.calls[0][0] as string[];
    expect(execArgs.slice(0, 6)).toEqual(['-f', 'concat', '-safe', '0', '-i', 'list.txt']);
  });

  it('falls back to ffprobe when the video probe yields no duration', async () => {
    const probeVideoDuration = vi.fn(async () => 0);
    const { inst, ctor } = fakeFFmpeg((name) => (name.endsWith('.txt') ? '8.0' : mp4Bytes(60_000)));
    const deps = createDeps({
      probeVideoDuration,
      importFFmpegCtor: vi.fn(async () => ctor),
      opfs: {
        // two webm chunks -> minimumDuration 7.5 forces the duration check
        readManifest: vi.fn(async () =>
          manifest({
            mimeType: 'video/webm',
            chunks: [
              { index: 0, size: 10, written: true, duration: 10, checksum: 'a' },
              { index: 1, size: 10, written: true, duration: 10, checksum: 'b' },
            ],
          }),
        ),
        readChunk: vi.fn(async () => new ArrayBuffer(100)),
        readWebCodecsStream: vi.fn(async () => new ArrayBuffer(0)),
      },
    });
    const proc = new Processor(deps);

    const result = await proc.processRecording('sess-1');
    expect(result.ok).toBe(true);
    expect(probeVideoDuration).toHaveBeenCalled();
    expect(inst.ffprobe).toHaveBeenCalled();
    expect(result.validation?.checks.duration).toBe(true);
  });

  it('validateLatestOutput returns a failed result before any output exists', async () => {
    const proc = new Processor(createDeps());
    const result = await proc.validateLatestOutput();
    expect(result.passed).toBe(false);
    expect(result.checks).toEqual({ size: false, header: false, duration: false });
  });
});
