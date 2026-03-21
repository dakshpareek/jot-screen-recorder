import type { OrphanedSession } from '@/lib/recording';
import OpfsWorker from '../../../workers/opfs-worker.ts?worker';
import type { SessionManifest, WorkerResponse } from '../types';

export class OpfsBridge {
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  async writeChunk(sessionId: string, chunkIndex: number, data: ArrayBuffer) {
    await this.callWorker(
      {
        type: 'write-chunk',
        sessionId,
        chunkIndex,
        data,
      },
      ['chunk-written'],
      [data],
    );
  }

  async writeManifest(sessionId: string, manifest: SessionManifest) {
    await this.callWorker(
      {
        type: 'write-manifest',
        sessionId,
        manifest,
      },
      ['manifest-written'],
    );
  }

  async readManifest(sessionId: string): Promise<SessionManifest> {
    const response = await this.callWorker(
      {
        type: 'read-manifest',
        sessionId,
      },
      ['manifest-data', 'manifest-not-found'],
    );

    if (response.type !== 'manifest-data' || !response.manifest) {
      throw new Error('Manifest not found');
    }

    return response.manifest;
  }

  async readChunk(sessionId: string, chunkIndex: number): Promise<ArrayBuffer> {
    const response = await this.callWorker(
      {
        type: 'read-chunk',
        sessionId,
        chunkIndex,
      },
      ['chunk-data', 'chunk-not-found'],
    );

    if (response.type !== 'chunk-data' || !response.data) {
      throw new Error(`Chunk ${chunkIndex} is missing`);
    }

    return response.data;
  }

  async scanOrphans(): Promise<OrphanedSession[]> {
    const response = await this.callWorker(
      {
        type: 'scan-orphans',
      },
      ['orphans-data'],
    );

    return Array.isArray(response.sessions) ? response.sessions : [];
  }

  async clearSession(sessionId: string) {
    await this.callWorker(
      {
        type: 'clear-session',
        sessionId,
      },
      ['cleared'],
    );
  }

  private async ensureWorker() {
    if (this.worker) return this.worker;

    this.worker = new OpfsWorker();
    this.worker.addEventListener('error', (event) => {
      console.error('[Offscreen] OPFS worker failed to load:', event.message);
    });
    this.worker.addEventListener('messageerror', () => {
      console.error('[Offscreen] OPFS worker message error');
    });

    return this.worker;
  }

  private async callWorker(
    message: Record<string, unknown>,
    expectedTypes: string[],
    transferables: Transferable[] = [],
  ): Promise<WorkerResponse> {
    await this.ensureWorker();

    const task = this.queue.then(
      () =>
        new Promise<WorkerResponse>((resolve, reject) => {
          const activeWorker = this.worker;
          if (!activeWorker) {
            reject(new Error('OPFS worker unavailable'));
            return;
          }

          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`OPFS worker timeout waiting for: ${expectedTypes.join(', ')}`));
          }, 10_000);

          const handleMessage = (event: MessageEvent<WorkerResponse>) => {
            const payload = event.data;
            if (!payload?.type) return;

            if (payload.type === 'error') {
              cleanup();
              reject(new Error(payload.message ?? 'OPFS worker error'));
              return;
            }

            if (expectedTypes.includes(payload.type)) {
              cleanup();
              resolve(payload);
            }
          };

          const cleanup = () => {
            clearTimeout(timeout);
            activeWorker.removeEventListener('message', handleMessage);
          };

          activeWorker.addEventListener('message', handleMessage);
          activeWorker.postMessage(message, transferables);
        }),
    );

    this.queue = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  }
}
