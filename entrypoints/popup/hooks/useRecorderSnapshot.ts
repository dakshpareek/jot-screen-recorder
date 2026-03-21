import { useCallback, useEffect, useState } from 'react';
import { RuntimeMessageType, type StateChangeMessage } from '@/lib/messages';
import type { RecordingSnapshot } from '@/lib/recording';

export function useRecorderSnapshot(initialSnapshot: RecordingSnapshot) {
  const [snapshot, setSnapshot] = useState<RecordingSnapshot>(initialSnapshot);

  const refreshState = useCallback(async () => {
    try {
      const latest = (await chrome.runtime.sendMessage({
        type: RuntimeMessageType.GET_STATE,
      })) as RecordingSnapshot;
      if (latest) {
        setSnapshot(latest);
      }
    } catch {
      // Background may still be waking up.
    }
  }, []);

  useEffect(() => {
    const listener = (message: unknown) => {
      const payload = message as Partial<StateChangeMessage>;
      if (payload.type === RuntimeMessageType.STATE_CHANGE && payload.snapshot) {
        setSnapshot(payload.snapshot);
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    void refreshState();
    void chrome.runtime
      .sendMessage({ type: RuntimeMessageType.REFRESH_ORPHANS })
      .catch(() => {});

    const interval = window.setInterval(() => {
      void refreshState();
    }, 1000);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      window.clearInterval(interval);
    };
  }, [refreshState]);

  return {
    snapshot,
    setSnapshot,
    refreshState,
  };
}
