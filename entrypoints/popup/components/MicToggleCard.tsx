import { useCallback, useEffect, useRef, useState } from 'react';

type MicToggleStatus = 'off' | 'checking' | 'ok' | 'waiting' | 'denied' | 'in_use';

type MicCheckResponse = {
  ok?: boolean;
  error?: string;
  level?: number;
  deviceLabel?: string | null;
};

export interface MicToggleCardProps {
  includeMic: boolean;
  onMicChange: (enabled: boolean) => void;
  onReadyChange?: (canStart: boolean) => void;
}

const MIN_CHECK_VISIBLE_MS = 1_800;
const DEVICE_POLL_MS = 2_000;
const BAR_BASE = [5, 9, 13, 16, 14, 11, 18, 9, 15, 19, 7, 16, 10, 13];

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

  .rk-mic-device {
    padding: 6px 8px;
    border-radius: 7px;
    border: 1px solid rgba(48,209,88,0.25);
    background: rgba(48,209,88,0.08);
    font-size: 11px;
    color: var(--rk-t);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .rk-mic-device-badge {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--rk-grn);
  }

  .rk-mic-level {
    margin-top: 8px;
    background: var(--rk-bg3);
    border-radius: 7px;
    padding: 6px 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .rk-mic-bars {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 14px;
    flex: 1;
  }
  .rk-mic-bar {
    width: 3px;
    border-radius: 1px;
    background: #2e2e33;
  }
  .rk-mic-bar.on { background: var(--rk-grn); }
  .rk-mic-level-text {
    font-size: 9px;
    color: var(--rk-t3);
    font-family: 'JetBrains Mono', monospace;
    min-width: 22px;
    text-align: right;
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

async function detectAudioInputLabel() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const first = devices.find((device) => device.kind === 'audioinput');
    return first?.label || null;
  } catch {
    return null;
  }
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

export function MicToggleCard({ includeMic, onMicChange, onReadyChange }: MicToggleCardProps) {
  useMicCardStyles();

  const [status, setStatus] = useState<MicToggleStatus>(includeMic ? 'checking' : 'off');
  const [deviceName, setDeviceName] = useState('Microphone');
  const [seedLevel, setSeedLevel] = useState(10);
  const [bars, setBars] = useState<number[]>(BAR_BASE);

  const runTokenRef = useRef(0);

  const runMicCheck = useCallback(async () => {
    const token = ++runTokenRef.current;
    setStatus('checking');

    const minDelay = wait(MIN_CHECK_VISIBLE_MS);
    let response: MicCheckResponse | null = null;
    try {
      response = (await chrome.runtime.sendMessage({ type: 'RUN_MIC_CHECK' })) as MicCheckResponse;
    } catch {
      response = { ok: false, error: 'MIC_CHECK_UNAVAILABLE' };
    }
    await minDelay;

    if (token !== runTokenRef.current) return;

    if (response?.ok) {
      const nextLevel = typeof response.level === 'number' ? Math.max(2, Math.min(35, Math.round(response.level))) : 10;
      setSeedLevel(nextLevel);
      const nextLabel = response.deviceLabel || (await detectAudioInputLabel()) || 'Microphone';
      if (token !== runTokenRef.current) return;
      setDeviceName(nextLabel);
      setStatus('ok');
      return;
    }

    const error = String(response?.error ?? 'MIC_NOT_FOUND');
    if (error === 'MIC_PERMISSION_DENIED' || error === 'MIC_PERMISSION_PROMPT') {
      setStatus('denied');
      return;
    }
    if (error === 'MIC_IN_USE') {
      setStatus('in_use');
      return;
    }
    setStatus('waiting');
  }, []);

  useEffect(() => {
    if (!includeMic) {
      runTokenRef.current += 1;
      setStatus('off');
      setBars(BAR_BASE);
      setSeedLevel(10);
      void chrome.runtime.sendMessage({ type: 'RELEASE_MIC_CHECK' }).catch(() => {});
      return;
    }

    if (status === 'off') {
      void runMicCheck();
    }
  }, [includeMic, status, runMicCheck]);

  useEffect(() => {
    if (!includeMic || status !== 'waiting') return;

    const interval = window.setInterval(() => {
      void (async () => {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const hasAudioInput = devices.some((device) => device.kind === 'audioinput');
          if (!hasAudioInput) return;
          window.clearInterval(interval);
          await runMicCheck();
        } catch {
          // Keep polling on transient enumerate failures.
        }
      })();
    }, DEVICE_POLL_MS);

    return () => window.clearInterval(interval);
  }, [includeMic, status, runMicCheck]);

  useEffect(() => {
    if (status !== 'ok') {
      setBars(BAR_BASE);
      return;
    }

    let tick = 0;
    const interval = window.setInterval(() => {
      tick += 1;
      const base = Math.max(3, Math.min(36, seedLevel));
      const nextBars = BAR_BASE.map((value, index) => {
        const wobble = Math.sin((tick + index) * 0.42) * 2.8;
        const noise = (Math.random() - 0.5) * 2.2;
        const scaled = value * (0.65 + base / 40);
        return Math.max(3, Math.min(22, Math.round(scaled + wobble + noise)));
      });
      setBars(nextBars);
    }, 120);

    return () => window.clearInterval(interval);
  }, [status, seedLevel]);

  useEffect(() => {
    const canStart = !includeMic || status === 'ok';
    onReadyChange?.(canStart);
  }, [includeMic, status, onReadyChange]);

  const handleToggle = () => {
    onMicChange(!includeMic);
  };

  const startDisabled = includeMic && status !== 'ok';
  const statusClass =
    status === 'ok'
      ? 'ok'
      : status === 'checking'
        ? 'checking'
        : status === 'waiting'
          ? 'waiting'
          : status === 'off'
            ? ''
            : 'error';
  const subClass =
    status === 'ok'
      ? 'ok'
      : status === 'checking'
        ? 'checking'
        : status === 'waiting'
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
          : status === 'waiting'
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
              <>
                <div className="rk-mic-device">
                  <span>{deviceName}</span>
                  <span className="rk-mic-device-badge">ACTIVE</span>
                </div>
                <div className="rk-mic-level">
                  <div className="rk-mic-bars">
                    {bars.map((height, index) => (
                      <div
                        key={index}
                        className={`rk-mic-bar${height >= 9 ? ' on' : ''}`}
                        style={{ height }}
                      />
                    ))}
                  </div>
                  <span className="rk-mic-level-text">{seedLevel}</span>
                </div>
              </>
            )}

            {status === 'waiting' && (
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
                  <button className="rk-mic-error-btn" onClick={() => void runMicCheck()}>
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
                  <button className="rk-mic-error-btn" onClick={() => void runMicCheck()}>
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {startDisabled && (
        <div className="rk-mic-hint">
          Turn off the microphone toggle to proceed without voice recording.
        </div>
      )}
    </>
  );
}
