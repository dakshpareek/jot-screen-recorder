import { useCallback, useEffect, useState } from 'react';
import { RuntimeMessageType, type EncoderBackend } from '@/lib/messages';

type EncoderSettingsResponse = {
  encoderBackend?: EncoderBackend;
} | null;

export function useEncoderSettings() {
  const [encoderBackend, setEncoderBackend] = useState<EncoderBackend>('webcodecs');

  useEffect(() => {
    let cancelled = false;

    async function loadEncoderSettings() {
      try {
        const settings = (await chrome.runtime.sendMessage({
          type: RuntimeMessageType.GET_ENCODER_SETTINGS,
        })) as EncoderSettingsResponse;

        if (cancelled) {
          return;
        }

        if (settings?.encoderBackend === 'webcodecs' || settings?.encoderBackend === 'mediarecorder') {
          setEncoderBackend(settings.encoderBackend);
        }
      } catch {
        // Ignore errors loading settings.
      }
    }

    void loadEncoderSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  const saveEncoderBackend = useCallback(async (nextBackend: EncoderBackend) => {
    setEncoderBackend(nextBackend);
    try {
      await chrome.runtime.sendMessage({
        type: RuntimeMessageType.SET_ENCODER_SETTINGS,
        settings: { encoderBackend: nextBackend },
      });
    } catch {
      // Ignore errors saving settings.
    }
  }, []);

  return {
    encoderBackend,
    setEncoderBackend: saveEncoderBackend,
  };
}
