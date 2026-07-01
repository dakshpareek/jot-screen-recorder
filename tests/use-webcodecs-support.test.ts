import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeMessageType } from '@/lib/messages';
import { useWebCodecsSupport } from '@/entrypoints/popup/hooks/useWebCodecsSupport';
import { installTestDom } from './helpers/linkedom';

describe('useWebCodecsSupport', () => {
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

  it('loads support state on mount', async () => {
    sendMessageMock.mockResolvedValue({
      videoSupported: true,
      audioSupported: true,
      hardwareAcceleration: true,
    });

    const { result } = renderHook(() => useWebCodecsSupport());

    await waitFor(() => {
      expect(result.current).toEqual({
        supported: true,
        hardwareAccelerated: true,
      });
    });

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: RuntimeMessageType.WEBCODECS_CHECK_SUPPORT,
      quality: 'auto',
    });
  });

  it('falls back through the callback when support is unavailable', async () => {
    sendMessageMock.mockResolvedValue({
      videoSupported: false,
      audioSupported: true,
      hardwareAcceleration: false,
    });

    const onUnsupported = vi.fn();
    const { result } = renderHook(() => useWebCodecsSupport(onUnsupported));

    await waitFor(() => {
      expect(result.current).toEqual({
        supported: false,
        hardwareAccelerated: false,
      });
    });

    expect(onUnsupported).toHaveBeenCalledTimes(1);
  });

  it('reports a false support state when probing fails', async () => {
    sendMessageMock.mockRejectedValue(new Error('probe failed'));

    const onUnsupported = vi.fn();
    const { result } = renderHook(() => useWebCodecsSupport(onUnsupported));

    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current).toEqual({
        supported: false,
        hardwareAccelerated: false,
      });
    });

    expect(onUnsupported).toHaveBeenCalledTimes(1);
  });
});
