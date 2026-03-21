import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeMessageType } from '@/lib/messages';
import { OffscreenClient } from '@/entrypoints/background/services/offscreen-client';

describe('OffscreenClient', () => {
  const sendMessageMock = vi.fn();
  const getURLMock = vi.fn((path: string) => `chrome-extension://test/${path}`);
  const hasDocumentMock = vi.fn();
  const createDocumentMock = vi.fn();
  const closeDocumentMock = vi.fn();

  beforeEach(() => {
    sendMessageMock.mockReset();
    getURLMock.mockReset();
    getURLMock.mockImplementation((path: string) => `chrome-extension://test/${path}`);
    hasDocumentMock.mockReset();
    createDocumentMock.mockReset();
    closeDocumentMock.mockReset();

    (globalThis as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: sendMessageMock,
        getURL: getURLMock,
      },
      offscreen: {
        hasDocument: hasDocumentMock,
        createDocument: createDocumentMock,
        closeDocument: closeDocumentMock,
      },
    };
  });

  it('proxies send() through chrome.runtime.sendMessage', async () => {
    const client = new OffscreenClient();
    sendMessageMock.mockResolvedValue({ ok: true });

    const response = await client.send<{ ok: boolean }>({ type: 'PING' });

    expect(response).toEqual({ ok: true });
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'PING' });
  });

  it('creates offscreen document and waits until status is alive', async () => {
    const client = new OffscreenClient();
    hasDocumentMock.mockResolvedValue(false);
    createDocumentMock.mockResolvedValue(undefined);
    sendMessageMock.mockResolvedValue({ alive: true });
    const delayMock = vi.fn(async (_ms: number) => {});

    await client.ensureReadyWithRetry(delayMock);

    expect(getURLMock).toHaveBeenCalledWith('offscreen-page.html');
    expect(createDocumentMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: RuntimeMessageType.OFFSCREEN_STATUS,
    });
    expect(delayMock).not.toHaveBeenCalled();
  });

  it('retries after an initial creation failure and then succeeds', async () => {
    const client = new OffscreenClient();

    hasDocumentMock.mockResolvedValue(false);
    createDocumentMock
      .mockRejectedValueOnce(new Error('create failed'))
      .mockResolvedValueOnce(undefined);
    sendMessageMock.mockResolvedValue({ alive: true });
    const delayMock = vi.fn(async (_ms: number) => {});

    await client.ensureReadyWithRetry(delayMock);

    expect(createDocumentMock).toHaveBeenCalledTimes(2);
    expect(delayMock).toHaveBeenCalledWith(150);
    expect(closeDocumentMock).not.toHaveBeenCalled();
  });

  it('polls with backoff when offscreen status is not alive yet', async () => {
    const client = new OffscreenClient();

    hasDocumentMock.mockResolvedValue(false);
    createDocumentMock.mockResolvedValue(undefined);
    sendMessageMock
      .mockResolvedValueOnce({ alive: false })
      .mockResolvedValueOnce({ alive: true });
    const delayMock = vi.fn(async (_ms: number) => {});

    await client.ensureReadyWithRetry(delayMock);

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(delayMock.mock.calls.map(([ms]) => ms)).toEqual([50]);
  });

  it('throws the last error after exhausting retries', async () => {
    const client = new OffscreenClient();

    hasDocumentMock.mockResolvedValue(false);
    createDocumentMock.mockRejectedValue(new Error('hard failure'));
    const delayMock = vi.fn(async (_ms: number) => {});

    await expect(client.ensureReadyWithRetry(delayMock)).rejects.toThrow('hard failure');

    expect(createDocumentMock).toHaveBeenCalledTimes(3);
    expect(delayMock.mock.calls.map(([ms]) => ms)).toEqual([150, 300, 450]);
  });

  it('skips status polling when already marked ready', async () => {
    const client = new OffscreenClient();
    client.markReady();

    hasDocumentMock.mockResolvedValue(true);
    const delayMock = vi.fn(async (_ms: number) => {});

    await client.ensureReadyWithRetry(delayMock);

    expect(createDocumentMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalledWith({
      type: RuntimeMessageType.OFFSCREEN_STATUS,
    });
    expect(delayMock).not.toHaveBeenCalled();
  });
});
