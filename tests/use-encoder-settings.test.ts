import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeMessageType } from '@/lib/messages';
import { useEncoderSettings } from '@/entrypoints/popup/hooks/useEncoderSettings';
import { installTestDom } from './helpers/linkedom';

describe('useEncoderSettings', () => {
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

  it('loads persisted encoder settings on mount', async () => {
    sendMessageMock.mockResolvedValue({ encoderBackend: 'mediarecorder' });

    const { result } = renderHook(() => useEncoderSettings());

    await waitFor(() => {
      expect(result.current.encoderBackend).toBe('mediarecorder');
    });

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: RuntimeMessageType.GET_ENCODER_SETTINGS,
    });
  });

  it('saves backend changes when updated', async () => {
    sendMessageMock.mockImplementation(async (message: { type: string }) => {
      if (message.type === RuntimeMessageType.GET_ENCODER_SETTINGS) {
        return { encoderBackend: 'webcodecs' };
      }
      return null;
    });

    const { result } = renderHook(() => useEncoderSettings());

    await act(async () => {
      await waitFor(() => {
        expect(result.current.encoderBackend).toBe('webcodecs');
      });
      await result.current.setEncoderBackend('mediarecorder');
    });

    expect(result.current.encoderBackend).toBe('mediarecorder');
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: RuntimeMessageType.SET_ENCODER_SETTINGS,
      settings: { encoderBackend: 'mediarecorder' },
    });
  });
});
