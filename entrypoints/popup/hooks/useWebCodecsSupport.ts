import { useEffect, useState } from 'react';
import { RuntimeMessageType } from '@/lib/messages';
import { debugWarn } from '@/lib/runtime-log';

type WebCodecsSupport = {
  supported: boolean;
  hardwareAccelerated: boolean;
} | null;

type WebCodecsSupportResponse = {
  videoSupported?: boolean;
  audioSupported?: boolean;
  hardwareAcceleration?: boolean;
} | null;

export function useWebCodecsSupport(onUnsupported?: () => void) {
  const [webCodecsSupport, setWebCodecsSupport] = useState<WebCodecsSupport>(null);

  useEffect(() => {
    let cancelled = false;

    async function checkSupport() {
      try {
        const result = (await chrome.runtime.sendMessage({
          type: RuntimeMessageType.WEBCODECS_CHECK_SUPPORT,
          quality: 'auto',
        })) as WebCodecsSupportResponse;

        if (cancelled) {
          return;
        }

        if (result) {
          const supported = result.videoSupported === true && result.audioSupported === true;
          setWebCodecsSupport({
            supported,
            hardwareAccelerated: result.hardwareAcceleration === true,
          });
          if (!supported) {
            onUnsupported?.();
          }
        } else {
          setWebCodecsSupport({ supported: false, hardwareAccelerated: false });
          onUnsupported?.();
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        debugWarn('[Popup] WebCodecs check error:', error);
        setWebCodecsSupport({ supported: false, hardwareAccelerated: false });
        onUnsupported?.();
      }
    }

    void checkSupport();

    return () => {
      cancelled = true;
    };
  }, [onUnsupported]);

  return webCodecsSupport;
}
