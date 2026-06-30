/**
 * Pure byte-level container inspection for recorded media blobs.
 *
 * These helpers only touch `ArrayBuffer` / `Blob` / `DataView`, so they are
 * unit-testable without a browser. Used by the processing/validation paths to
 * detect MP4 vs WebM and to recover a duration when `HTMLVideoElement` cannot.
 */

export function isMp4ArrayBuffer(data: ArrayBuffer) {
  if (data.byteLength < 12) return false;
  const view = new Uint8Array(data, 4, 4);
  return (
    view[0] === 0x66 && // f
    view[1] === 0x74 && // t
    view[2] === 0x79 && // y
    view[3] === 0x70 // p
  );
}

export async function hasMp4FtypHeader(blob: Blob) {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (header.length < 8) return false;
  const tag = String.fromCharCode(header[4], header[5], header[6], header[7]);
  return tag === 'ftyp';
}

export async function hasWebmEbmlHeader(blob: Blob) {
  const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (header.length < 4) return false;
  return header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
}

export async function probeMp4DurationFromMetadata(blob: Blob): Promise<number> {
  if (blob.size < 32) return 0;

  const scanBytes = Math.min(blob.size, 4 * 1024 * 1024);
  const buffer = await blob.slice(0, scanBytes).arrayBuffer();
  const view = new DataView(buffer);
  return findMvhdDuration(view, 0, view.byteLength);
}

export function findMvhdDuration(view: DataView, start: number, end: number): number {
  let offset = start;

  while (offset + 8 <= end) {
    let boxSize = view.getUint32(offset);
    const type = readBoxType(view, offset + 4);
    let headerSize = 8;

    if (boxSize === 1) {
      if (offset + 16 > end) return 0;
      boxSize = readUint64(view, offset + 8);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = end - offset;
    }

    if (boxSize < headerSize) return 0;
    if (offset + boxSize > end) return 0;

    if (type === 'moov') {
      const nested = findMvhdDuration(view, offset + headerSize, offset + boxSize);
      if (nested > 0) return nested;
    } else if (type === 'mvhd') {
      const payload = offset + headerSize;
      if (payload + 20 > end) return 0;

      const version = view.getUint8(payload);
      if (version === 0) {
        const timescale = view.getUint32(payload + 12);
        const duration = view.getUint32(payload + 16);
        if (timescale > 0 && duration > 0) {
          return duration / timescale;
        }
      } else if (version === 1) {
        if (payload + 32 > end) return 0;
        const timescale = view.getUint32(payload + 20);
        const duration = readUint64(view, payload + 24);
        if (timescale > 0 && duration > 0) {
          return duration / timescale;
        }
      }
    }

    offset += boxSize;
  }

  return 0;
}

export function readBoxType(view: DataView, offset: number) {
  if (offset + 4 > view.byteLength) return '';
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export function readUint64(view: DataView, offset: number) {
  if (offset + 8 > view.byteLength) return 0;
  const high = view.getUint32(offset);
  const low = view.getUint32(offset + 4);
  return high * 2 ** 32 + low;
}
