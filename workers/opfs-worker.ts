// @ts-nocheck
// OPFS Worker — synchronous writes via createSyncAccessHandle
// This is the exact pattern that will be used in production

const MANIFEST_FILE = 'manifest.json';
const MANIFEST_TMP_FILE = 'manifest.tmp';
const DEFAULT_WEBCODECS_STREAM_FILE = 'webcodecs-stream.mp4';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function writeFileBytesAtomic(fileHandle, bytes) {
  const handle = await fileHandle.createSyncAccessHandle();
  try {
    handle.truncate(0);
    handle.write(bytes);
    handle.flush();
  } finally {
    handle.close();
  }
}

async function readFileText(fileHandle) {
  const handle = await fileHandle.createSyncAccessHandle();
  try {
    const size = handle.getSize();
    if (size <= 0) return '';

    const buffer = new Uint8Array(size);
    const bytesRead = handle.read(buffer);
    return textDecoder.decode(buffer.subarray(0, Math.max(0, bytesRead)));
  } finally {
    handle.close();
  }
}

async function removeEntryIfExists(sessionDir, fileName) {
  try {
    await sessionDir.removeEntry(fileName);
  } catch (error) {
    if (error?.name !== 'NotFoundError') {
      throw error;
    }
  }
}

async function writeManifestAtomic(sessionDir, manifest) {
  const serialized = JSON.stringify(manifest);
  const encoded = textEncoder.encode(serialized);

  const tmpHandle = await sessionDir.getFileHandle(MANIFEST_TMP_FILE, { create: true });
  await writeFileBytesAtomic(tmpHandle, encoded);

  const tmpText = await readFileText(tmpHandle);
  if (tmpText !== serialized) {
    throw new Error('Manifest tmp write verification failed');
  }

  const manifestHandle = await sessionDir.getFileHandle(MANIFEST_FILE, { create: true });
  await writeFileBytesAtomic(manifestHandle, encoded);

  const committedText = await readFileText(manifestHandle);
  if (committedText !== serialized) {
    throw new Error('Manifest commit verification failed');
  }

  await removeEntryIfExists(sessionDir, MANIFEST_TMP_FILE);
}

async function readManifestWithRecovery(sessionDir) {
  try {
    const manifestHandle = await sessionDir.getFileHandle(MANIFEST_FILE);
    const text = await readFileText(manifestHandle);
    return JSON.parse(text);
  } catch (error) {
    if (error?.name !== 'NotFoundError') {
      throw error;
    }
  }

  // Crash-during-commit recovery:
  // if manifest.json is missing but manifest.tmp exists, promote tmp to committed manifest.
  const tmpHandle = await sessionDir.getFileHandle(MANIFEST_TMP_FILE);
  const tmpText = await readFileText(tmpHandle);
  const recoveredManifest = JSON.parse(tmpText);
  const encoded = textEncoder.encode(tmpText);

  const manifestHandle = await sessionDir.getFileHandle(MANIFEST_FILE, { create: true });
  await writeFileBytesAtomic(manifestHandle, encoded);

  const committedText = await readFileText(manifestHandle);
  if (committedText !== tmpText) {
    throw new Error('Manifest recovery promotion failed');
  }

  await removeEntryIfExists(sessionDir, MANIFEST_TMP_FILE);
  return recoveredManifest;
}

function toFiniteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function buildOrphanSummary(directoryName, manifest) {
  const chunks = Array.isArray(manifest?.chunks) ? manifest.chunks : [];
  const streamBytes = toFiniteNumber(manifest?.streamBytesWritten);
  const isWebCodecs = manifest?.recordingKind === 'webcodecs-opfs';
  const totalSize = isWebCodecs
    ? streamBytes
    : chunks.reduce((sum, chunk) => sum + toFiniteNumber(chunk?.size), 0);
  return {
    sessionId:
      typeof manifest?.sessionId === 'string' && manifest.sessionId.length
        ? manifest.sessionId
        : directoryName,
    startTime: toFiniteNumber(manifest?.startTime),
    chunkCount: isWebCodecs ? (streamBytes > 0 ? 1 : 0) : chunks.length,
    totalSize,
  };
}

async function scanOrphanedSessions(root) {
  const sessions = [];

  for await (const [name, handle] of root.entries()) {
    if (!name.startsWith('rec_')) continue;
    if (handle.kind !== 'directory') continue;

    try {
      const sessionDir = await root.getDirectoryHandle(name);
      const manifest = await readManifestWithRecovery(sessionDir);
      if (manifest?.status === 'recording') {
        sessions.push(buildOrphanSummary(name, manifest));
      }
    } catch {
      // Ignore malformed/missing manifests.
    }
  }

  sessions.sort((a, b) => b.startTime - a.startTime);
  return sessions;
}

self.onmessage = async (e) => {
  const { type, sessionId, chunkIndex, data, manifest, position, streamFile } = e.data;

  try {
    const root = await navigator.storage.getDirectory();

    if (type === 'write-webcodecs-range') {
      const fileName =
        typeof streamFile === 'string' && streamFile.length > 0
          ? streamFile
          : DEFAULT_WEBCODECS_STREAM_FILE;
      const sessionDir = await root.getDirectoryHandle(sessionId, { create: true });
      const fileHandle = await sessionDir.getFileHandle(fileName, { create: true });
      const handle = await fileHandle.createSyncAccessHandle();
      try {
        const bytes = new Uint8Array(data);
        handle.write(bytes, { at: toFiniteNumber(position, 0) });
        handle.flush();
      } finally {
        handle.close();
      }
      self.postMessage({ type: 'webcodecs-range-written' });
    }

    else if (type === 'read-webcodecs-stream') {
      try {
        const fileName =
          typeof streamFile === 'string' && streamFile.length > 0
            ? streamFile
            : DEFAULT_WEBCODECS_STREAM_FILE;
        const sessionDir = await root.getDirectoryHandle(sessionId);
        const fileHandle = await sessionDir.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        self.postMessage({ type: 'webcodecs-stream-data', data: buffer }, [buffer]);
      } catch {
        self.postMessage({ type: 'webcodecs-stream-not-found' });
      }
    }

    else if (type === 'write-chunk') {
      const sessionDir = await root.getDirectoryHandle(sessionId, { create: true });
      const chunkFile = await sessionDir.getFileHandle(`chunk-${chunkIndex}.bin`, { create: true });

      // createSyncAccessHandle — this is the fast synchronous write API
      // Only available in dedicated workers — this is why we use a worker
      const handle = await chunkFile.createSyncAccessHandle();
      handle.write(new DataView(data));
      handle.flush();
      handle.close();

      self.postMessage({ type: 'chunk-written', chunkIndex });
    }

    else if (type === 'read-chunk') {
      try {
        const sessionDir = await root.getDirectoryHandle(sessionId);
        const chunkFile = await sessionDir.getFileHandle(`chunk-${chunkIndex}.bin`);
        const file = await chunkFile.getFile();
        const buffer = await file.arrayBuffer();
        self.postMessage({ type: 'chunk-data', chunkIndex, data: buffer, found: true }, [buffer]);
      } catch {
        self.postMessage({ type: 'chunk-not-found', chunkIndex, found: false });
      }
    }

    else if (type === 'write-manifest') {
      const sessionDir = await root.getDirectoryHandle(sessionId, { create: true });
      await writeManifestAtomic(sessionDir, manifest);
      self.postMessage({ type: 'manifest-written' });
    }

    else if (type === 'read-manifest') {
      try {
        const sessionDir = await root.getDirectoryHandle(sessionId);
        const manifestData = await readManifestWithRecovery(sessionDir);
        self.postMessage({ type: 'manifest-data', manifest: manifestData });
      } catch {
        self.postMessage({ type: 'manifest-not-found' });
      }
    }

    else if (type === 'clear-session') {
      try {
        await root.removeEntry(sessionId, { recursive: true });
      } catch {}
      self.postMessage({ type: 'cleared' });
    }

    else if (type === 'clear-all') {
      for await (const [name] of root.entries()) {
        await root.removeEntry(name, { recursive: true });
      }
      self.postMessage({ type: 'cleared' });
    }

    else if (type === 'scan-orphans') {
      const sessions = await scanOrphanedSessions(root);
      self.postMessage({ type: 'orphans-data', sessions });
    }

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
