// @ts-nocheck
// OPFS Worker — synchronous writes via createSyncAccessHandle
// This is the exact pattern that will be used in production

self.onmessage = async (e) => {
  const { type, sessionId, chunkIndex, data, manifest } = e.data;

  try {
    const root = await navigator.storage.getDirectory();

    if (type === 'write-chunk') {
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
      // Atomic write: write to .tmp first, then rename
      const tmpFile = await sessionDir.getFileHandle('manifest.tmp', { create: true });
      const handle = await tmpFile.createSyncAccessHandle();
      const encoded = new TextEncoder().encode(JSON.stringify(manifest));
      handle.truncate(0);
      handle.write(encoded);
      handle.flush();
      handle.close();
      // In a real implementation, rename .tmp -> manifest.json here
      // OPFS doesn't have rename yet in all browsers, so we write directly for the spike
      const manifestFile = await sessionDir.getFileHandle('manifest.json', { create: true });
      const mHandle = await manifestFile.createSyncAccessHandle();
      mHandle.truncate(0);
      mHandle.write(encoded);
      mHandle.flush();
      mHandle.close();
      self.postMessage({ type: 'manifest-written' });
    }

    else if (type === 'read-manifest') {
      try {
        const sessionDir = await root.getDirectoryHandle(sessionId);
        const manifestFile = await sessionDir.getFileHandle('manifest.json');
        const file = await manifestFile.getFile();
        const text = await file.text();
        self.postMessage({ type: 'manifest-data', manifest: JSON.parse(text) });
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

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
