import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeMessageType } from '@/lib/messages';
import { useRecorderCommands } from '@/entrypoints/popup/hooks/useRecorderCommands';
import { installTestDom } from './helpers/linkedom';
import { createSnapshot } from './helpers/snapshot';

describe('useRecorderCommands', () => {
  const sendMessageMock = vi.fn();
  let restoreDom = () => {};

  beforeEach(() => {
    restoreDom = installTestDom();
    sendMessageMock.mockReset();

    (globalThis as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: sendMessageMock,
      },
    };
  });

  afterEach(() => {
    restoreDom();
  });

  it('sends command payloads and forwards snapshot updates', async () => {
    const snapshot = createSnapshot({ state: 'recording', chunkCount: 2 });
    sendMessageMock.mockResolvedValue({
      ok: true,
      snapshot,
    });

    const onSnapshot = vi.fn();
    const { result } = renderHook(() => useRecorderCommands(onSnapshot));

    let response: unknown;
    await act(async () => {
      response = await result.current.send(RuntimeMessageType.START, { includeMic: true });
    });

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: RuntimeMessageType.START,
      includeMic: true,
    });
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(response).toEqual({ ok: true, snapshot });
    expect(result.current.isBusy).toBe(false);
  });

  it('sets isBusy while a command is in flight', async () => {
    let resolveMessage: ((value: unknown) => void) | undefined;
    sendMessageMock.mockReturnValue(
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    );

    const { result } = renderHook(() => useRecorderCommands(() => {}));

    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.send(RuntimeMessageType.STOP);
    });

    await waitFor(() => {
      expect(result.current.isBusy).toBe(true);
    });

    resolveMessage?.({ ok: true });

    await act(async () => {
      await pending;
    });

    expect(result.current.isBusy).toBe(false);
  });

  it('returns null when background responds with undefined', async () => {
    sendMessageMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useRecorderCommands(() => {}));

    let response: unknown;
    await act(async () => {
      response = await result.current.send(RuntimeMessageType.DOWNLOAD);
    });

    expect(response).toBeNull();
    expect(result.current.isBusy).toBe(false);
  });

  it('returns a normalized error payload when messaging fails', async () => {
    sendMessageMock.mockRejectedValue(new Error('background unavailable'));
    const { result } = renderHook(() => useRecorderCommands(() => {}));

    let response: unknown;
    await act(async () => {
      response = await result.current.send(RuntimeMessageType.GET_STATE);
    });

    expect(response).toEqual({
      ok: false,
      error: 'background unavailable',
    });
    expect(result.current.isBusy).toBe(false);
  });
});
