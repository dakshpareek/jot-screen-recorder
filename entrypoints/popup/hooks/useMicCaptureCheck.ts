import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RuntimeMessageType } from '@/lib/messages';
import type { AudioPreflightSnapshot } from '@/lib/recording';

export type MicToggleStatus =
  | 'off'
  | 'checking'
  | 'ok'
  | 'waiting'
  | 'denied'
  | 'in_use'
  | 'not_found';

const DEVICE_POLL_MS = 2_000;

const BAR_BASE = [5, 9, 7, 12, 8, 11, 6, 10];

type MicCheckResponse = {
  ok?: boolean;
  error?: string;
  deviceLabel?: string | null;
};

function normalizeMicDeviceId(deviceId: string) {
  if (!deviceId || deviceId === 'default') {
    return undefined;
  }
  return deviceId;
}

function mapMicErrorToStatus(error: string | null | undefined): MicToggleStatus {
  if (error === 'MIC_PERMISSION_DENIED' || error === 'MIC_PERMISSION_PROMPT') {
    return 'denied';
  }
  if (error === 'MIC_IN_USE') {
    return 'in_use';
  }
  if (error === 'MIC_NOT_FOUND') {
    return 'not_found';
  }
  if (!error) {
    return 'waiting';
  }
  return 'waiting';
}

export function useMicCaptureCheck({
  includeMic,
  selectedDeviceId,
  onSelectedDeviceIdChange,
  onReadyChange,
  audioPreflight,
}: {
  includeMic: boolean;
  selectedDeviceId: string;
  onSelectedDeviceIdChange: (next: string) => void;
  onReadyChange?: (canStart: boolean) => void;
  audioPreflight: AudioPreflightSnapshot;
}) {
  const [isChecking, setIsChecking] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceName, setDeviceName] = useState('Microphone');
  const [levelBars, setLevelBars] = useState<number[]>([...BAR_BASE]);
  const checkRunRef = useRef(0);

  const refreshAudioDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === 'audioinput');
      setAudioDevices(inputs);

      if (!inputs.length) {
        return;
      }

      const selectedExists =
        selectedDeviceId === 'default' || inputs.some((device) => device.deviceId === selectedDeviceId);
      if (!selectedExists) {
        onSelectedDeviceIdChange(inputs[0].deviceId);
      }
    } catch {
      setAudioDevices([]);
    }
  }, [onSelectedDeviceIdChange, selectedDeviceId]);

  const runCheck = useCallback(
    async (overrideDeviceId?: string) => {
      if (!includeMic) {
        return;
      }

      const runId = ++checkRunRef.current;
      setIsChecking(true);

      try {
        const requestedDeviceId = normalizeMicDeviceId(overrideDeviceId ?? selectedDeviceId);
        const payload: Record<string, unknown> = { type: RuntimeMessageType.RUN_MIC_CHECK };
        if (requestedDeviceId) {
          payload.micDeviceId = requestedDeviceId;
        }

        const result = (await chrome.runtime.sendMessage(payload)) as MicCheckResponse;
        if (runId !== checkRunRef.current) {
          return;
        }

        if (result?.deviceLabel) {
          setDeviceName(result.deviceLabel);
        } else if (result?.ok) {
          setDeviceName('Microphone');
        }
      } catch {
        // The polling snapshot reconciles UI even if this command fails.
      } finally {
        if (runId === checkRunRef.current) {
          setIsChecking(false);
        }
      }

      await refreshAudioDevices();
    },
    [includeMic, refreshAudioDevices, selectedDeviceId],
  );

  useEffect(() => {
    if (!includeMic) {
      checkRunRef.current += 1;
      setIsChecking(false);
      setAudioDevices([]);
      setDeviceName('Microphone');
      setLevelBars([...BAR_BASE]);
      void chrome.runtime
        .sendMessage({ type: RuntimeMessageType.RELEASE_MIC_CHECK })
        .catch(() => {});
      return;
    }

    void refreshAudioDevices();
    void runCheck();
  }, [includeMic, refreshAudioDevices, runCheck]);

  useEffect(() => {
    if (!includeMic) {
      return;
    }

    const handleDeviceChange = () => {
      void refreshAudioDevices();
      void runCheck();
    };

    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
    };
  }, [includeMic, refreshAudioDevices, runCheck]);

  useEffect(() => {
    if (!includeMic || (audioPreflight.micOk || isChecking)) {
      return;
    }

    const status = mapMicErrorToStatus(audioPreflight.micError);
    if (status !== 'waiting' && status !== 'not_found') {
      return;
    }

    const interval = window.setInterval(() => {
      void (async () => {
        await refreshAudioDevices();
        await runCheck();
      })();
    }, DEVICE_POLL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [audioPreflight.micError, audioPreflight.micOk, includeMic, isChecking, refreshAudioDevices, runCheck]);

  useEffect(() => {
    const canStart = !includeMic || (audioPreflight.micChecked && audioPreflight.micOk);
    onReadyChange?.(canStart);
  }, [audioPreflight.micChecked, audioPreflight.micOk, includeMic, onReadyChange]);

  useEffect(() => {
    if (!includeMic || !audioPreflight.micOk) {
      setLevelBars([...BAR_BASE]);
      return;
    }

    const rawLevel = typeof audioPreflight.micLevel === 'number' ? audioPreflight.micLevel : 0;
    const normalized = Math.max(0, Math.min(1, rawLevel / 35));

    const timer = window.setInterval(() => {
      setLevelBars(
        BAR_BASE.map((value, index) => {
          const wobble = ((Date.now() / 120 + index) % 3) - 1;
          const next = value + normalized * 5 + wobble;
          return Math.max(2, Math.min(13, next));
        }),
      );
    }, 120);

    return () => {
      window.clearInterval(timer);
    };
  }, [audioPreflight.micLevel, audioPreflight.micOk, includeMic]);

  const status: MicToggleStatus = useMemo(() => {
    if (!includeMic) {
      return 'off';
    }
    if (isChecking) {
      return 'checking';
    }
    if (audioPreflight.micChecked && audioPreflight.micOk) {
      return 'ok';
    }
    if (!audioPreflight.micChecked) {
      return 'waiting';
    }
    return mapMicErrorToStatus(audioPreflight.micError);
  }, [audioPreflight.micChecked, audioPreflight.micError, audioPreflight.micOk, includeMic, isChecking]);

  const subtitle = useMemo(() => {
    if (status === 'off') {
      return "Your voice won't be recorded";
    }
    if (status === 'checking') {
      return 'Checking microphone access...';
    }
    if (status === 'ok') {
      return 'Mic ready - preflight passed';
    }
    if (status === 'waiting' || status === 'not_found') {
      return 'No microphone found - waiting for device';
    }
    if (status === 'denied') {
      return 'Permission blocked';
    }
    return 'Microphone in use';
  }, [status]);

  return {
    status,
    subtitle,
    audioDevices,
    deviceName,
    levelBars,
    runCheck,
  };
}
