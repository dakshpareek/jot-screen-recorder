/**
 * Orphan scan / recovery-inspection / raw-export logic, factored out of the
 * offscreen script so it can be unit-tested against a fake OPFS bridge instead
 * of a live offscreen document.
 *
 * All persistence goes through the injected `opfs` port; checksum + object-URL
 * creation are injected too so the service stays free of `crypto`/`URL` globals
 * at the type level and is fully fakeable.
 */
import type {
  RecoveryChunkCheck,
  RecoveryChunkStatus,
} from '@/lib/recording';
import type { TestOrphanFixtureSession } from '@/lib/messages';
import { normalizeResolvedCaptureQuality } from '@/lib/capture-presets';
import { buildRawExportBaseName, toErrorMessage } from '../../background/utils';
import { normalizeCaptureQuality } from '../utils';
import type { OpfsBridge } from '../storage/opfs-bridge';
import type { RawDownloadItem, SessionManifest } from '../types';

const RAW_EXPORT_REVOKE_DELAY_MS = 10 * 60 * 1000;

export interface RecoveryServiceDeps {
  opfs: Pick<
    OpfsBridge,
    'readManifest' | 'readChunk' | 'readWebCodecsStream' | 'writeManifest' | 'scanOrphans' | 'clearSession'
  >;
  sha256(data: ArrayBuffer): Promise<string>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export class RecoveryService {
  private readonly rawExportUrls = new Set<string>();
  private rawExportRevokeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: RecoveryServiceDeps) {}

  webCodecsOpfsStreamName(manifest: SessionManifest): string {
    return manifest.webCodecsOpfsStreamFile ?? 'webcodecs-stream.mp4';
  }

  async scanOrphanedSessions() {
    return {
      ok: true,
      sessions: await this.deps.opfs.scanOrphans(),
    };
  }

  buildSeededOrphanManifest(session: TestOrphanFixtureSession): SessionManifest {
    return {
      sessionId: session.sessionId,
      startTime: session.startTime,
      recordingQuality: normalizeCaptureQuality(session.recordingQuality),
      recordingResolvedQuality: normalizeResolvedCaptureQuality(session.recordingResolvedQuality),
      mimeType: typeof session.mimeType === 'string' ? session.mimeType : 'video/webm',
      chunks: [],
      totalDuration: 0,
      status: 'recording',
      recordingKind: session.recordingKind ?? 'webcodecs-opfs',
      streamBytesWritten: Math.max(1, session.streamBytesWritten ?? 1),
    };
  }

  async seedOrphanedSessions(sessions: TestOrphanFixtureSession[]) {
    for (const session of sessions) {
      await this.deps.opfs.writeManifest(session.sessionId, this.buildSeededOrphanManifest(session));
    }

    return {
      ok: true,
      sessions: await this.deps.opfs.scanOrphans(),
    };
  }

  async clearSessionData(sessionId: string) {
    if (!sessionId) {
      return { ok: false, error: 'Missing session id' };
    }

    await this.deps.opfs.clearSession(sessionId);

    return { ok: true };
  }

  async inspectRecoveryChunks(sessionId: string) {
    if (!sessionId) {
      return { ok: false, error: 'Missing session id' };
    }

    try {
      const manifestData = await this.deps.opfs.readManifest(sessionId);
      const requestedPreset = normalizeCaptureQuality(manifestData.recordingQuality);
      const resolvedPreset = normalizeResolvedCaptureQuality(
        manifestData.recordingResolvedQuality ?? manifestData.recordingQuality,
      );

      if (manifestData.recordingKind === 'webcodecs-opfs') {
        try {
          const data = await this.deps.opfs.readWebCodecsStream(
            sessionId,
            this.webCodecsOpfsStreamName(manifestData),
          );
          const checksum = await this.deps.sha256(data);
          return {
            ok: true,
            chunks: [
              {
                index: 0,
                size: data.byteLength,
                status: data.byteLength > 1000 ? 'ok' : 'suspect',
                expectedChecksum: null,
                actualChecksum: checksum,
                included: true,
              },
            ],
            recordingQuality: requestedPreset,
            recordingResolvedQuality: resolvedPreset,
          };
        } catch {
          return {
            ok: true,
            chunks: [
              {
                index: 0,
                size: 0,
                status: 'missing',
                expectedChecksum: null,
                actualChecksum: null,
                included: false,
              },
            ],
            recordingQuality: requestedPreset,
            recordingResolvedQuality: resolvedPreset,
          };
        }
      }

      const chunks = [...manifestData.chunks].sort((a, b) => a.index - b.index);
      const checks: RecoveryChunkCheck[] = [];

      for (const chunk of chunks) {
        let status: RecoveryChunkStatus = 'ok';
        let actualChecksum: string | null = null;
        const expectedChecksum = chunk.checksum || null;
        try {
          const data = await this.deps.opfs.readChunk(sessionId, chunk.index);
          actualChecksum = await this.deps.sha256(data);
          if (!expectedChecksum || actualChecksum !== expectedChecksum) {
            status = 'suspect';
          }
        } catch {
          status = 'missing';
        }

        checks.push({
          index: chunk.index,
          size: chunk.size,
          status,
          expectedChecksum,
          actualChecksum,
          included: status !== 'missing',
        });
      }

      return {
        ok: true,
        chunks: checks,
        recordingQuality: requestedPreset,
        recordingResolvedQuality: resolvedPreset,
      };
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
      };
    }
  }

  async downloadRawChunks(sessionId: string) {
    if (!sessionId) {
      return { ok: false, error: 'Missing session id' };
    }

    try {
      const manifestData = await this.deps.opfs.readManifest(sessionId);

      if (manifestData.recordingKind === 'webcodecs-opfs') {
        try {
          const streamFile = this.webCodecsOpfsStreamName(manifestData);
          const data = await this.deps.opfs.readWebCodecsStream(sessionId, streamFile);
          const baseName = buildRawExportBaseName(manifestData.exportBaseName, sessionId);
          const items: RawDownloadItem[] = [];
          const manifestBlob = new Blob([JSON.stringify(manifestData, null, 2)], {
            type: 'application/json',
          });
          items.push({
            url: this.deps.createObjectURL(manifestBlob),
            filename: `${baseName}/manifest.json`,
          });
          const streamBlob = new Blob([data], {
            type: manifestData.mimeType || 'video/mp4',
          });
          items.push({
            url: this.deps.createObjectURL(streamBlob),
            filename: `${baseName}/${streamFile}`,
          });
          this.scheduleRawExportUrlCleanup(items.map((item) => item.url));
          return { ok: true, items };
        } catch (error) {
          return {
            ok: false,
            error: toErrorMessage(error),
          };
        }
      }

      const orderedChunks = [...manifestData.chunks].sort((a, b) => a.index - b.index);
      if (!orderedChunks.length) {
        return { ok: false, error: 'No chunks found for this session' };
      }

      const baseName = buildRawExportBaseName(manifestData.exportBaseName, sessionId);
      const chunkExt = (manifestData.mimeType ?? '').includes('mp4') ? 'mp4' : 'webm';

      const items: RawDownloadItem[] = [];
      const manifestBlob = new Blob([JSON.stringify(manifestData, null, 2)], {
        type: 'application/json',
      });
      items.push({
        url: this.deps.createObjectURL(manifestBlob),
        filename: `${baseName}/manifest.json`,
      });

      for (const chunk of orderedChunks) {
        try {
          const data = await this.deps.opfs.readChunk(sessionId, chunk.index);
          const chunkBlob = new Blob([data], {
            type: manifestData.mimeType || 'application/octet-stream',
          });
          items.push({
            url: this.deps.createObjectURL(chunkBlob),
            filename: `${baseName}/chunk-${chunk.index}.${chunkExt}`,
          });
        } catch {
          // Skip missing chunks and continue exporting everything available.
        }
      }

      if (!items.length) {
        return { ok: false, error: 'No exportable files found for this session' };
      }

      this.scheduleRawExportUrlCleanup(items.map((item) => item.url));
      return { ok: true, items };
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
      };
    }
  }

  private scheduleRawExportUrlCleanup(urls: string[]) {
    for (const url of urls) {
      this.rawExportUrls.add(url);
    }

    if (this.rawExportRevokeTimer) {
      clearTimeout(this.rawExportRevokeTimer);
    }

    this.rawExportRevokeTimer = setTimeout(() => {
      for (const url of this.rawExportUrls) {
        this.deps.revokeObjectURL(url);
      }
      this.rawExportUrls.clear();
      this.rawExportRevokeTimer = null;
    }, RAW_EXPORT_REVOKE_DELAY_MS);
  }
}
