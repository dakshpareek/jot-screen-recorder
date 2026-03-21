import { RuntimeMessageType } from '@/lib/messages';
import type { AudioPreflightSnapshot } from '@/lib/recording';
import { useMicCaptureCheck } from '../hooks/useMicCaptureCheck';
import '../styles/mic-toggle-card.css';

export interface MicToggleCardProps {
  includeMic: boolean;
  onMicChange: (enabled: boolean) => void;
  onReadyChange?: (canStart: boolean) => void;
  selectedDeviceId: string;
  onSelectedDeviceIdChange: (deviceId: string) => void;
  audioPreflight: AudioPreflightSnapshot;
}

export function MicToggleCard({
  includeMic,
  onMicChange,
  onReadyChange,
  selectedDeviceId,
  onSelectedDeviceIdChange,
  audioPreflight,
}: MicToggleCardProps) {
  const { status, subtitle, audioDevices, deviceName, levelBars, runCheck } = useMicCaptureCheck({
    includeMic,
    selectedDeviceId,
    onSelectedDeviceIdChange,
    onReadyChange,
    audioPreflight,
  });

  const handleToggle = () => {
    onMicChange(!includeMic);
  };

  const handleDeviceChange = (deviceId: string) => {
    onSelectedDeviceIdChange(deviceId);
    void runCheck(deviceId);
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
                    onChange={(e) => handleDeviceChange(e.target.value)}>
                    {audioDevices.map((device, index) => (
                      <option key={device.deviceId || `device-${index}`} value={device.deviceId}>
                        {device.label || `Microphone ${index + 1}`}
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
                    onClick={() =>
                      void chrome.runtime.sendMessage({
                        type: RuntimeMessageType.OPEN_MIC_SETTINGS,
                      })
                    }>
                    Open settings
                  </button>
                  <button className="rk-mic-error-btn" onClick={() => void runCheck()}>
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
                  <button className="rk-mic-error-btn" onClick={() => void runCheck()}>
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
