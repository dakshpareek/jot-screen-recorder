import { useCallback, useEffect, useRef, useState } from 'react';

type MicToggleStatus = 'off' | 'checking' | 'ok' | 'waiting' | 'denied' | 'in_use' | 'not_found';

export interface MicToggleCardProps {
  includeMic: boolean;
  onMicChange: (enabled: boolean) => void;
  onReadyChange?: (canStart: boolean) => void;
  onMicStreamReady?: (stream: MediaStream | null) => void;
}

const MIN_CHECK_VISIBLE_MS = 1_800;
const DEVICE_POLL_MS = 2_000;
const BAR_BASE = [5, 9, 7, 12, 8, 11, 6, 10];
const BIN_RANGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 7],
  [7, 11],
  [11, 18],
];
const ATTACK = 0.75;
const DECAY = 0.1;
const SILENCE = 0.025;
let animTick = 0;

const STYLES = `
  .rk-mic-card {
    background: var(--rk-bg2);
    border: 1px solid var(--rk-b);
    border-radius: 10px;
    padding: 11px 12px;
    margin: 12px 0;
    transition: border-color 0.2s;
  }
  .rk-mic-card.checking, .rk-mic-card.waiting { border-color: rgba(255,214,10,0.3); }
  .rk-mic-card.ok { border-color: rgba(48,209,88,0.3); }
  .rk-mic-card.error { border-color: rgba(255,59,48,0.3); }

  .rk-mic-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .rk-mic-label { font-size: 12px; font-weight: 600; color: var(--rk-t); }
  .rk-mic-sub { font-size: 10px; color: var(--rk-t3); margin-top: 2px; }
  .rk-mic-sub.checking, .rk-mic-sub.waiting { color: var(--rk-amb); }
  .rk-mic-sub.ok { color: var(--rk-grn); }
  .rk-mic-sub.error { color: var(--rk-red2); }

  .rk-mic-toggle {
    width: 36px;
    height: 20px;
    border: none;
    border-radius: 10px;
    background: var(--rk-bg4);
    position: relative;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.2s;
  }
  .rk-mic-toggle::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    transition: left 0.2s;
  }
  .rk-mic-toggle.on { background: var(--rk-red); }
  .rk-mic-toggle.on::after { left: 18px; }
  .rk-mic-toggle.ok { background: var(--rk-grn); }

  .rk-mic-detail { margin-top: 10px; }

  .rk-mic-checking {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--rk-amb);
  }
  .rk-mic-spinner {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--rk-bg3);
    border-top-color: var(--rk-amb);
    animation: rk-mic-spin 0.8s linear infinite;
  }
  @keyframes rk-mic-spin { to { transform: rotate(360deg); } }

  .rk-device-row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #1c1c20;
    border: 1px solid rgba(48,209,88,0.25);
    border-radius: 8px;
    padding: 7px 10px;
    margin-bottom: 0;
  }

  .rk-inline-bars {
    display: flex;
    align-items: center;
    gap: 1.5px;
    height: 14px;
    flex-shrink: 0;
  }

  .rk-ib {
    width: 2.5px;
    border-radius: 1.5px;
    background: rgba(48,209,88,0.2);
    transition: height 0.06s ease, background 0.06s ease;
    flex-shrink: 0;
  }

  .rk-ib.rk-ib-lit { background: #30d158; }

  .rk-device-name {
    font-size: 11px;
    font-weight: 600;
    color: #f0f0f2;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rk-device-select {
    flex: 1;
    background: transparent;
    border: none;
    color: #f0f0f2;
    font-size: 11px;
    font-family: 'Syne', sans-serif;
    font-weight: 600;
    cursor: pointer;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    min-width: 0;
    background-image: url("data:image/svg+xml,%3Csvg width='9' height='5' viewBox='0 0 9 5' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l3.5 3.5L8 1' stroke='%2330d158' stroke-width='1.4' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0 center;
    padding-right: 16px;
  }

  .rk-device-select option {
    background: #1c1c20;
    color: #f0f0f2;
    font-weight: 400;
  }

  .rk-device-active {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: #30d158;
    flex-shrink: 0;
  }

  .rk-mic-wait {
    padding: 8px;
    border-radius: 7px;
    border: 1px solid rgba(255,214,10,0.25);
    background: rgba(255,214,10,0.08);
    font-size: 11px;
    color: var(--rk-amb);
    line-height: 1.45;
  }

  .rk-mic-error {
    padding: 8px;
    border-radius: 7px;
    border: 1px solid rgba(255,59,48,0.25);
    background: rgba(255,59,48,0.06);
  }
  .rk-mic-error-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--rk-red2);
    margin-bottom: 4px;
  }
  .rk-mic-error-body {
    font-size: 10px;
    color: var(--rk-t2);
    line-height: 1.45;
    margin-bottom: 6px;
  }
  .rk-mic-error-btns {
    display: flex;
    gap: 6px;
  }
  .rk-mic-error-btn {
    padding: 5px 8px;
    border-radius: 6px;
    border: 1px solid rgba(255,59,48,0.3);
    background: transparent;
    color: var(--rk-red2);
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
    font-family: 'Syne', sans-serif;
  }
  .rk-mic-error-btn:hover { background: rgba(255,59,48,0.1); }

  .rk-mic-hint {
    font-size: 10px;
    color: var(--rk-t2);
    text-align: center;
    margin-top: 6px;
    line-height: 1.45;
  }
`;

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function useMicCardStyles() {
  useEffect(() => {
    const id = 'rk-mic-card-styles';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = STYLES;
    document.head.appendChild(el);
  }, []);
}

export function MicToggleCard({
  includeMic,
  onMicChange,
  onReadyChange,
  onMicStreamReady,
}: MicToggleCardProps) {
  useMicCardStyles();

  const [status, setStatus] = useState<MicToggleStatus>(includeMic ? 'checking' : 'off');
  const [deviceName, setDeviceName] = useState('Microphone');
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('default');
  const [levelBars, setLevelBars] = useState<number[]>([5, 9, 7, 12, 8, 11, 6, 10]);

  const runTokenRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const levelRafRef = useRef<number>(0);

  const stopStream = useCallback(() => {
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = 0;
    }

    analyserRef.current = null;

    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    onMicStreamReady?.(null);
    setLevelBars([...BAR_BASE]);
  }, [onMicStreamReady]);

  const startLevelAnimation = useCallback((stream: MediaStream) => {
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = 0;
    }

    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      const smooth = new Float32Array(BIN_RANGES.length).fill(2);

      const frame = () => {
        analyser.getByteFrequencyData(data);
        const rms = Math.sqrt(
          data.reduce((acc, value) => acc + (value / 255) ** 2, 0) / data.length,
        );
        const isActive = rms > SILENCE;

        setLevelBars(
          BIN_RANGES.map(([rawLo, rawHi], i) => {
            let target = 2;

            if (!isActive) {
              target = 2 + Math.sin(animTick * 0.06 + i * 1.1) * 0.7;
            } else {
              const lo = Math.max(0, Math.min(rawLo, data.length - 1));
              const hi = Math.max(lo + 1, Math.min(rawHi, data.length));
              let sum = 0;
              for (let b = lo; b < hi; b += 1) {
                sum += data[b];
              }
              const binEnergy = sum / ((hi - lo) * 255);
              target = 2 + binEnergy * 11;
            }

            const lerpFactor = target > smooth[i] ? ATTACK : DECAY;
            smooth[i] += (target - smooth[i]) * lerpFactor;
            return Math.max(2, Math.min(13, smooth[i]));
          }),
        );

        animTick += 1;
        levelRafRef.current = requestAnimationFrame(frame);
      };

      levelRafRef.current = requestAnimationFrame(frame);
    } catch {
      // AudioContext blocked - bars stay static
    }
  }, []);

  const checkMic = useCallback(async () => {
    const token = ++runTokenRef.current;
    setStatus('checking');
    stopStream();

    const minDelay = wait(MIN_CHECK_VISIBLE_MS);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 44100,
          channelCount: 1,
        },
      });

      await minDelay;
      if (token !== runTokenRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      onMicStreamReady?.(stream);

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter((d) => d.kind === 'audioinput' && d.label);
        setAudioDevices(inputs);

        const trackLabel = stream.getAudioTracks()[0]?.label ?? '';
        const active = inputs.find((d) => d.label === trackLabel);
        setDeviceName(active?.label ?? trackLabel ?? 'Microphone');
        setSelectedDeviceId(active?.deviceId ?? 'default');
      } catch {
        setAudioDevices([]);
      }

      setStatus('ok');
      startLevelAnimation(stream);
    } catch (error: unknown) {
      await minDelay;
      if (token !== runTokenRef.current) return;

      const name = error instanceof Error ? error.name : 'UnknownError';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setStatus('denied');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        setStatus('in_use');
      } else {
        setStatus('waiting');
      }
      setAudioDevices([]);
    }
  }, [onMicStreamReady, startLevelAnimation, stopStream]);

  const handleDeviceChange = useCallback(
    async (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      stopStream();
      setStatus('checking');

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId === 'default' ? undefined : { exact: deviceId },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 44100,
            channelCount: 1,
          },
        });

        const selected = audioDevices.find((d) => d.deviceId === deviceId);
        setDeviceName(selected?.label ?? 'Microphone');
        streamRef.current = stream;
        onMicStreamReady?.(stream);
        setStatus('ok');
        startLevelAnimation(stream);
      } catch (err: unknown) {
        const name = err instanceof Error ? err.name : 'UnknownError';
        setStatus(name === 'NotAllowedError' ? 'denied' : 'not_found');
      }
    },
    [audioDevices, onMicStreamReady, startLevelAnimation, stopStream],
  );

  useEffect(() => {
    if (!includeMic) {
      runTokenRef.current += 1;
      stopStream();
      setStatus('off');
      setDeviceName('Microphone');
      setAudioDevices([]);
      setSelectedDeviceId('default');
      void chrome.runtime.sendMessage({ type: 'RELEASE_MIC_CHECK' }).catch(() => {});
      return;
    }

    if (status === 'off') {
      void checkMic();
    }
  }, [checkMic, includeMic, status, stopStream]);

  useEffect(() => {
    if (!includeMic || (status !== 'waiting' && status !== 'not_found')) return;

    const interval = window.setInterval(() => {
      void (async () => {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const hasAudioInput = devices.some((device) => device.kind === 'audioinput');
          if (!hasAudioInput) return;
          window.clearInterval(interval);
          await checkMic();
        } catch {
          // Keep polling on transient enumerate failures.
        }
      })();
    }, DEVICE_POLL_MS);

    return () => window.clearInterval(interval);
  }, [checkMic, includeMic, status]);

  useEffect(() => {
    const canStart = !includeMic || status === 'ok';
    onReadyChange?.(canStart);
  }, [includeMic, onReadyChange, status]);

  useEffect(() => {
    return () => {
      runTokenRef.current += 1;
      stopStream();
    };
  }, [stopStream]);

  const handleToggle = () => {
    onMicChange(!includeMic);
  };

  const startDisabled = includeMic && status !== 'ok';
  const statusClass =
    status === 'ok'
      ? 'ok'
      : status === 'checking'
        ? 'checking'
        : status === 'waiting' || status === 'not_found'
          ? 'waiting'
          : status === 'off'
            ? ''
            : 'error';

  const subClass =
    status === 'ok'
      ? 'ok'
      : status === 'checking'
        ? 'checking'
        : status === 'waiting' || status === 'not_found'
          ? 'waiting'
          : status === 'off'
            ? ''
            : 'error';

  const subtitle =
    status === 'off'
      ? "Your voice won't be recorded"
      : status === 'checking'
        ? 'Requesting microphone access...'
        : status === 'ok'
          ? 'Mic ready - signal detected'
          : status === 'waiting' || status === 'not_found'
            ? 'No microphone found - waiting for device'
            : status === 'denied'
              ? 'Permission blocked'
              : 'Microphone in use';

  return (
    <>
      <div className={`rk-mic-card ${statusClass}`}>
        <div className="rk-mic-top">
          <div>
            <div className="rk-mic-label">Include microphone</div>
            <div className={`rk-mic-sub ${subClass}`}>{subtitle}</div>
          </div>
          <button
            className={`rk-mic-toggle${includeMic ? ' on' : ''}${status === 'ok' ? ' ok' : ''}`}
            onClick={handleToggle}
            aria-label={includeMic ? 'Disable microphone' : 'Enable microphone'}
          />
        </div>

        {includeMic && (
          <div className="rk-mic-detail">
            {status === 'checking' && (
              <div className="rk-mic-checking">
                <div className="rk-mic-spinner" />
                <span>Checking microphone...</span>
              </div>
            )}

            {status === 'ok' && (
              <div className="rk-device-row">
                <div className="rk-inline-bars">
                  {levelBars.map((h, i) => (
                    <div
                      key={i}
                      className={`rk-ib${h > 5 ? ' rk-ib-lit' : ''}`}
                      style={{ height: Math.round(h) }}
                    />
                  ))}
                </div>

                {audioDevices.length > 1 ? (
                  <select
                    className="rk-device-select"
                    value={selectedDeviceId}
                    onChange={(e) => void handleDeviceChange(e.target.value)}>
                    {audioDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="rk-device-name">{deviceName}</span>
                )}

                <span className="rk-device-active">Active</span>
              </div>
            )}

            {(status === 'waiting' || status === 'not_found') && (
              <div className="rk-mic-wait">
                No microphone detected. Connect a device and we will auto-check again every 2 seconds.
              </div>
            )}

            {status === 'denied' && (
              <div className="rk-mic-error">
                <div className="rk-mic-error-title">Microphone permission blocked</div>
                <div className="rk-mic-error-body">
                  Allow microphone access in Chrome, or turn this toggle off to record without voice.
                </div>
                <div className="rk-mic-error-btns">
                  <button
                    className="rk-mic-error-btn"
                    onClick={() => void chrome.runtime.sendMessage({ type: 'OPEN_MIC_SETTINGS' })}>
                    Open settings
                  </button>
                  <button className="rk-mic-error-btn" onClick={() => void checkMic()}>
                    Retry
                  </button>
                </div>
              </div>
            )}

            {status === 'in_use' && (
              <div className="rk-mic-error">
                <div className="rk-mic-error-title">Microphone is currently in use</div>
                <div className="rk-mic-error-body">
                  Close other apps using the mic, or turn this toggle off to continue without voice.
                </div>
                <div className="rk-mic-error-btns">
                  <button className="rk-mic-error-btn" onClick={() => void checkMic()}>
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {startDisabled && (
        <div className="rk-mic-hint">Turn off the microphone toggle to proceed without voice recording.</div>
      )}
    </>
  );
}
