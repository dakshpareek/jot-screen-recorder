import { describe, expect, it } from 'vitest';
import {
  findMvhdDuration,
  hasMp4FtypHeader,
  hasWebmEbmlHeader,
  isMp4ArrayBuffer,
  probeMp4DurationFromMetadata,
  readBoxType,
  readUint64,
} from '@/entrypoints/offscreen/media/container-probe';

function box(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  view.setUint32(0, size);
  for (let i = 0; i < 4; i += 1) buf[4 + i] = type.charCodeAt(i);
  buf.set(payload, 8);
  return buf;
}

function mvhdBoxV0(timescale: number, duration: number): Uint8Array {
  const p = new Uint8Array(20);
  const v = new DataView(p.buffer);
  v.setUint8(0, 0); // version 0
  v.setUint32(12, timescale);
  v.setUint32(16, duration);
  return box('mvhd', p);
}

function mvhdBoxV1(timescale: number, duration: number): Uint8Array {
  const p = new Uint8Array(32);
  const v = new DataView(p.buffer);
  v.setUint8(0, 1); // version 1
  v.setUint32(20, timescale);
  // 64-bit duration: high word 0, low word = duration
  v.setUint32(24, 0);
  v.setUint32(28, duration);
  return box('mvhd', p);
}

function ftypBuffer(): ArrayBuffer {
  const payload = new Uint8Array(8);
  for (let i = 0; i < 4; i += 1) payload[i] = 'isom'.charCodeAt(i);
  const buf = box('ftyp', payload);
  return buf.buffer.slice(0) as ArrayBuffer;
}

describe('container-probe', () => {
  it('detects mp4 ftyp in an ArrayBuffer', () => {
    expect(isMp4ArrayBuffer(ftypBuffer())).toBe(true);
    expect(isMp4ArrayBuffer(new Uint8Array([0, 1, 2, 3]).buffer)).toBe(false);
    expect(isMp4ArrayBuffer(new Uint8Array(4).buffer)).toBe(false); // too short
  });

  it('detects mp4 ftyp header in a Blob', async () => {
    expect(await hasMp4FtypHeader(new Blob([ftypBuffer()]))).toBe(true);
    expect(await hasMp4FtypHeader(new Blob([new Uint8Array(20)]))).toBe(false);
  });

  it('detects the WebM EBML magic in a Blob', async () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]);
    expect(await hasWebmEbmlHeader(new Blob([webm]))).toBe(true);
    expect(await hasWebmEbmlHeader(new Blob([new Uint8Array([0, 1, 2, 3])]))).toBe(false);
  });

  it('parses an mvhd v0 duration via moov nesting', () => {
    const moov = box('moov', mvhdBoxV0(1000, 5000));
    const view = new DataView(moov.buffer);
    expect(findMvhdDuration(view, 0, view.byteLength)).toBeCloseTo(5);
  });

  it('parses an mvhd v1 (64-bit) duration', () => {
    const moov = box('moov', mvhdBoxV1(600, 1800));
    const view = new DataView(moov.buffer);
    expect(findMvhdDuration(view, 0, view.byteLength)).toBeCloseTo(3);
  });

  it('probes duration from an mp4 metadata Blob', async () => {
    const ftyp = box('ftyp', new Uint8Array(24));
    const moov = box('moov', mvhdBoxV0(1000, 12000));
    const merged = new Uint8Array(ftyp.length + moov.length);
    merged.set(ftyp, 0);
    merged.set(moov, ftyp.length);
    expect(await probeMp4DurationFromMetadata(new Blob([merged]))).toBeCloseTo(12);
  });

  it('returns 0 for truncated or garbage buffers', () => {
    expect(findMvhdDuration(new DataView(new ArrayBuffer(4)), 0, 4)).toBe(0);
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x61, 0x62, 0x63, 0x64]);
    expect(findMvhdDuration(new DataView(garbage.buffer), 0, garbage.length)).toBe(0);
  });

  it('returns 0 when the blob is too small to hold metadata', async () => {
    expect(await probeMp4DurationFromMetadata(new Blob([new Uint8Array(10)]))).toBe(0);
  });

  it('reads box types and 64-bit ints', () => {
    const moov = box('moov', mvhdBoxV0(1, 1));
    const view = new DataView(moov.buffer);
    expect(readBoxType(view, 4)).toBe('moov');
    expect(readBoxType(view, moov.length)).toBe(''); // out of range

    const u64 = new Uint8Array(8);
    new DataView(u64.buffer).setUint32(4, 42);
    expect(readUint64(new DataView(u64.buffer), 0)).toBe(42);
  });
});
