import type { CommandResponse, RuntimeMessageTypeValue } from '@/lib/messages';
import { useCallback, useState } from 'react';
import type { RecordingSnapshot } from '@/lib/recording';

export function useRecorderCommands(onSnapshot: (next: RecordingSnapshot) => void) {
  const [isBusy, setIsBusy] = useState(false);

  const send = useCallback(
    async (type: RuntimeMessageTypeValue, extra?: Record<string, unknown>): Promise<CommandResponse> => {
      setIsBusy(true);
      try {
        const result = (await chrome.runtime.sendMessage({ type, ...extra })) as CommandResponse;
        if (result?.snapshot) {
          onSnapshot(result.snapshot);
        }
        return result ?? null;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Message to background failed',
        };
      } finally {
        setIsBusy(false);
      }
    },
    [onSnapshot],
  );

  return {
    isBusy,
    send,
  };
}
