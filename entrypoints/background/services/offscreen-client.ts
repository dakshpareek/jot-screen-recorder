import { RuntimeMessageType } from '@/lib/messages';

const OFFSCREEN_PING_INITIAL_INTERVAL_MS = 50;
const OFFSCREEN_PING_MAX_INTERVAL_MS = 400;
const OFFSCREEN_PING_TIMEOUT_MS = 10_000;

export class OffscreenClient {
  private ready = false;

  markReady() {
    this.ready = true;
  }

  async send<T>(message: Record<string, unknown>): Promise<T> {
    return (await chrome.runtime.sendMessage(message)) as T;
  }

  async ensureReadyWithRetry(delay: (ms: number) => Promise<void>) {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (attempt === 0) {
          await this.ensureDocument();
        } else {
          await this.recreateDocument();
        }

        await this.waitForReady(delay);
        return;
      } catch (error) {
        lastError = error;
        await delay(150 * (attempt + 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Unable to initialize offscreen recorder');
  }

  async forceResetDocument() {
    await this.recreateDocument();
  }

  private async ensureDocument() {
    if (await chrome.offscreen.hasDocument()) return;

    this.ready = false;

    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen-page.html'),
      reasons: [
        'DISPLAY_MEDIA' as chrome.offscreen.Reason,
        'USER_MEDIA' as chrome.offscreen.Reason,
      ],
      justification: 'MediaRecorder for screen capture',
    });
  }

  private async recreateDocument() {
    try {
      if (await chrome.offscreen.hasDocument()) {
        await chrome.offscreen.closeDocument();
      }
    } catch {
      // Ignore close failures and retry creation.
    }

    this.ready = false;
    await this.ensureDocument();
  }

  private async waitForReady(
    delay: (ms: number) => Promise<void>,
    timeoutMs = OFFSCREEN_PING_TIMEOUT_MS,
  ) {
    if (this.ready) return;

    const deadline = Date.now() + timeoutMs;
    let delayMs = OFFSCREEN_PING_INITIAL_INTERVAL_MS;

    while (Date.now() < deadline) {
      if (this.ready) return;

      try {
        const status = await this.send<{ alive?: boolean }>({
          type: RuntimeMessageType.OFFSCREEN_STATUS,
        });
        if (status?.alive) {
          this.ready = true;
          return;
        }
      } catch {
        // Message port is not ready yet; retry with backoff.
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      await delay(Math.min(delayMs, remainingMs));
      delayMs = Math.min(delayMs * 2, OFFSCREEN_PING_MAX_INTERVAL_MS);
    }

    throw new Error(`Offscreen document did not become ready within ${timeoutMs}ms`);
  }
}
