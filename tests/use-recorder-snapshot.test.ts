import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeMessageType } from '@/lib/messages';
import { useRecorderSnapshot } from '@/entrypoints/popup/hooks/useRecorderSnapshot';
import { installTestDom } from './helpers/linkedom';
import { createSnapshot } from './helpers/snapshot';

type RuntimeListener = (message: unknown) => void;

describe('useRecorderSnapshot', () => {
  const sendMessageMock = vi.fn();
  const addListenerMock = vi.fn();
  const removeListenerMock = vi.fn();
  let listeners: RuntimeListener[] = [];
  let restoreDom = () => {};

  beforeEach(() => {
    restoreDom = installTestDom();
    sendMessageMock.mockReset();
    addListenerMock.mockReset();
    removeListenerMock.mockReset();
    listeners = [];

    addListenerMock.mockImplementation((listener: RuntimeListener) => {
      listeners.push(listener);
    });
    removeListenerMock.mockImplementation((listener: RuntimeListener) => {
      listeners = listeners.filter((item) => item !== listener);
    });

    (globalThis as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: {
          addListener: addListenerMock,
          removeListener: removeListenerMock,
        },
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreDom();
  });

  it('loads latest state and requests orphan refresh on mount', async () => {
    const initial = createSnapshot({ state: 'idle' });
    const latest = createSnapshot({ state: 'preflight', elapsedSeconds: 7 });

    sendMessageMock.mockImplementation(async (message: { type: string }) => {
      if (message.type === RuntimeMessageType.GET_STATE) return latest;
      if (message.type === RuntimeMessageType.REFRESH_ORPHANS) return null;
      return null;
    });

    const { result } = renderHook(() => useRecorderSnapshot(initial));

    await waitFor(() => {
      expect(result.current.snapshot).toEqual(latest);
    });

    expect(addListenerMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith({ type: RuntimeMessageType.GET_STATE });
    expect(sendMessageMock).toHaveBeenCalledWith({ type: RuntimeMessageType.REFRESH_ORPHANS });
  });

  it('applies incoming state-change messages and ignores unrelated ones', async () => {
    const initial = createSnapshot({ state: 'idle' });
    sendMessageMock.mockResolvedValue(null);

    const { result } = renderHook(() => useRecorderSnapshot(initial));
    const listener = listeners[0];

    const changed = createSnapshot({ state: 'recording', chunkCount: 5 });
    act(() => {
      listener({
        type: RuntimeMessageType.STATE_CHANGE,
        snapshot: changed,
      });
    });

    expect(result.current.snapshot).toEqual(changed);

    const before = result.current.snapshot;
    act(() => {
      listener({ type: 'UNRELATED_EVENT' });
    });
    expect(result.current.snapshot).toEqual(before);
  });

  it('polls for state every second and removes listener on unmount', async () => {
    vi.useFakeTimers();

    const initial = createSnapshot({ state: 'idle' });
    const first = createSnapshot({ state: 'preflight' });
    const second = createSnapshot({ state: 'recording', chunkCount: 1 });

    let getStateCalls = 0;
    sendMessageMock.mockImplementation(async (message: { type: string }) => {
      if (message.type === RuntimeMessageType.REFRESH_ORPHANS) return null;
      if (message.type === RuntimeMessageType.GET_STATE) {
        getStateCalls += 1;
        return getStateCalls === 1 ? first : second;
      }
      return null;
    });

    const { result, unmount } = renderHook(() => useRecorderSnapshot(initial));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.snapshot).toEqual(first);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.snapshot).toEqual(second);

    const registeredListener = listeners[0];
    unmount();

    expect(removeListenerMock).toHaveBeenCalledWith(registeredListener);
  });

  it('handles refresh failures without throwing', async () => {
    const initial = createSnapshot({ state: 'idle' });

    sendMessageMock.mockImplementation(async (message: { type: string }) => {
      if (message.type === RuntimeMessageType.REFRESH_ORPHANS) return null;
      if (message.type === RuntimeMessageType.GET_STATE) {
        throw new Error('background still booting');
      }
      return null;
    });

    const { result } = renderHook(() => useRecorderSnapshot(initial));

    await act(async () => {
      await expect(result.current.refreshState()).resolves.toBeUndefined();
    });

    expect(result.current.snapshot).toEqual(initial);
  });
});
