import type { ReactNode } from 'react';
import type { CaptureQuality, CaptureResolvedQuality, EncoderBackend } from '@/lib/messages';
import { toCaptureQualityLabel, toResolvedQualityLabel } from '@/lib/capture-presets';
import {
  type AudioPreflightSnapshot,
  type OrphanedSession,
  type RecordingSnapshot,
  type RecordingState,
} from '@/lib/recording';

function LockIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" strokeWidth="1.4" strokeLinecap="round">
      <rect x="2" y="5" width="8" height="6" rx="1" />
      <path d="M4 5V3.5a2 2 0 114 0V5" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.3 3.3l.85.85M11.8 11.8l.85.85M3.3 12.7l.85-.85M11.8 4.2l.85-.85" />
    </svg>
  );
}

function RecDot() {
  return <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'white', flexShrink: 0 }} />;
}

function StopSquare() {
  return <div style={{ width: 9, height: 9, background: 'var(--jot-red)', borderRadius: 2, flexShrink: 0 }} />;
}

function MicLevelBars({ level }: { level: number | null }) {
  const heights = [10, 16, 8, 20, 14, 22, 6, 18, 12, 24, 8, 16];
  const litCount = level === null ? 0 : Math.max(1, Math.min(12, Math.round((level / 30) * 12)));
  return (
    <div className="jot-pf-bars">
      {heights.map((h, i) => (
        <div key={i} className={`jot-pf-bar${i < litCount ? ' lit' : ''}`} style={{ height: h }} />
      ))}
    </div>
  );
}

function Waveform() {
  const bars = Array.from({ length: 52 }, (_, i) => {
    const h = 4 + ((i * 7 + 13) % 27);
    const delay = (i * 0.023) % 0.5;
    const dur = 0.35 + (i * 0.013) % 0.35;
    return (
      <div
        key={i}
        className="jot-wave-bar"
        style={{ height: h, animationDelay: `${delay}s`, animationDuration: `${dur}s` }}
      />
    );
  });
  return <div className="jot-waveform">{bars}</div>;
}

function Timer({ seconds }: { seconds: number }) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return (
      <div className="jot-timer">
        {h}
        <span className="jot-timer-sep">:</span>
        {String(m).padStart(2, '0')}
        <span className="jot-timer-sep">:</span>
        {String(s).padStart(2, '0')}
      </div>
    );
  }
  return (
    <div className="jot-timer">
      {m}
      <span className="jot-timer-sep">:</span>
      {String(s).padStart(2, '0')}
    </div>
  );
}

function ChunkDots({ count, safeCount }: { count: number; safeCount: number }) {
  const maxDots = 8;
  const display = Math.min(count + 1, maxDots);
  return (
    <div className="jot-chunk-dots">
      {Array.from({ length: display }, (_, i) => (
        <div key={i} className={`jot-chunk-dot${i >= safeCount ? ' pending' : ''}`} />
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatOrphanTime(ms: number): string {
  if (!ms) return 'Unknown';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const QUALITY_PRESET_OPTIONS: Array<{ id: CaptureQuality; title: string; subtitle: string }> = [
  { id: 'auto', title: 'Auto', subtitle: 'Best stable preset' },
  { id: '1080p30', title: '1080p • 30fps', subtitle: 'Balanced quality' },
  { id: '1080p60', title: '1080p • 60fps', subtitle: 'Smoother motion' },
  { id: '4k30', title: '4K • 30fps', subtitle: 'Highest detail' },
];

export function Header({
  state,
  onSettings,
}: {
  state: RecordingState;
  onSettings: () => void;
}) {
  const isRecording = state === 'recording' || state === 'audio_warning' || state === 'stopping';
  const isProcessing = state === 'processing' || state === 'validating';
  const isDone = state === 'done';

  return (
    <div className="jot-header">
      <div className="jot-header-left">
        <div className="jot-logo-mark">
          <svg viewBox="0 0 12 12">
            <circle cx="6" cy="6" r="3.5" />
            <line x1="6" y1="2.5" x2="6" y2="6" />
            <line x1="6" y1="6" x2="8.5" y2="6" />
          </svg>
        </div>
        <span className="jot-header-name">Jot — Screen Recorder</span>
      </div>
      <div className="jot-header-right">
        {isRecording && <span className="jot-badge jot-badge-rec">● REC</span>}
        {isProcessing && <span className="jot-badge jot-badge-proc">◐ Processing</span>}
        {isDone && <span className="jot-badge jot-badge-done">✓ Ready</span>}
        {(state === 'idle' || state === 'done' || state === 'error') && (
          <button className="jot-icon-btn" onClick={onSettings} title="Settings">
            <SettingsIcon />
          </button>
        )}
      </div>
    </div>
  );
}

function Footer({ label }: { label: string }) {
  return (
    <div className="jot-footer">
      <span className="jot-footer-lbl">{label}</span>
      <div className="jot-footer-local">
        <LockIcon />
        <span>Local only</span>
      </div>
    </div>
  );
}

export function IdleScreen({
  micControl,
  onStart,
  isBusy,
  canStartRecording,
  startButtonLabel,
  orphan,
  onRecoverOrphan,
  onDiscardOrphan,
  storageWarning,
  showSettings,
  onSettingsClose,
  quality,
  onQualityChange,
  encoderBackend,
  onEncoderBackendChange,
  webCodecsSupport,
}: {
  micControl: ReactNode;
  onStart: () => void;
  isBusy: boolean;
  canStartRecording: boolean;
  startButtonLabel: string;
  orphan: RecordingSnapshot['orphanedSessions'][0] | null;
  onRecoverOrphan: (id: string) => void;
  onDiscardOrphan: (id: string) => void;
  storageWarning: string | null;
  showSettings: boolean;
  onSettingsClose: () => void;
  quality: CaptureQuality;
  onQualityChange: (q: CaptureQuality) => void;
  encoderBackend: EncoderBackend;
  onEncoderBackendChange: (backend: EncoderBackend) => void;
  webCodecsSupport: { supported: boolean; hardwareAccelerated: boolean } | null;
}) {
  const webCodecsUnavailable = webCodecsSupport !== null && !webCodecsSupport.supported;
  const useLegacyEncoder = encoderBackend === 'mediarecorder' || webCodecsUnavailable;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div className="jot-body">
        {orphan && (
          <div className="jot-orphan-card">
            <div className="jot-orphan-title">Interrupted recording found</div>
            <div className="jot-orphan-meta">
              {formatOrphanTime(orphan.startTime)} · {orphan.chunkCount} chunks ·{' '}
              {formatBytes(orphan.totalSize)}
            </div>
            <div className="jot-orphan-btns">
              <button
                className="jot-orphan-p"
                disabled={isBusy}
                onClick={() => onRecoverOrphan(orphan.sessionId)}>
                Process &amp; Download
              </button>
              <button
                className="jot-orphan-s"
                disabled={isBusy}
                onClick={() => onDiscardOrphan(orphan.sessionId)}>
                Discard
              </button>
            </div>
          </div>
        )}

        {orphan && (
          <div className="jot-divider">
            <div className="jot-divider-label">New recording</div>
          </div>
        )}

        {!orphan && (
          <div className="jot-hero">
            <div className="jot-hero-eyebrow">
              <div className="jot-hero-eyebrow-dot" />
              Your recordings are always safe
            </div>
            <div className="jot-hero-title">
              Record anything.
              <br />
              <em>Lose nothing.</em>
            </div>
            <div className="jot-outcomes">
              <div className="jot-outcome jot-outcome-green">
                <svg viewBox="0 0 10 10" fill="none" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M2 5l2 2 4-4" />
                </svg>
                Never lose a recording
              </div>
              <div className="jot-outcome jot-outcome-blue">
                <svg viewBox="0 0 10 10" fill="none" strokeWidth="1.5" strokeLinecap="round">
                  <rect x="2" y="4.5" width="6" height="4.5" rx="1" />
                  <path d="M3.5 4.5V3a1.5 1.5 0 013 0v1.5" />
                </svg>
                Stays on your device
              </div>
              <div className="jot-outcome jot-outcome-amber">
                <svg viewBox="0 0 10 10" fill="none" strokeWidth="1.5" strokeLinecap="round">
                  <rect x="1" y="2" width="8" height="6" rx="1" />
                  <polygon points="3.5,3.5 3.5,6.5 7,5" />
                </svg>
                Plays anywhere
              </div>
            </div>
          </div>
        )}

        {storageWarning && (
          <div className="jot-storage-warn">
            <svg viewBox="0 0 12 12" fill="none" strokeWidth="1.4" strokeLinecap="round">
              <path d="M6 1L11 10H1L6 1z" />
              <line x1="6" y1="5" x2="6" y2="7.5" />
              <circle cx="6" cy="9" r="0.5" fill="var(--jot-amb)" stroke="none" />
            </svg>
            <span>{storageWarning}</span>
          </div>
        )}

        {micControl}

        <button className="jot-btn-record" disabled={isBusy || !canStartRecording} onClick={onStart}>
          <RecDot />
          {startButtonLabel}
        </button>
      </div>
      <Footer label="Ready to record" />

      {showSettings && (
        <div className="jot-settings-overlay">
          <div className="jot-settings-header">
            <span className="jot-settings-title">Settings</span>
            <button className="jot-settings-close" onClick={onSettingsClose}>
              <svg viewBox="0 0 10 10" fill="none">
                <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" />
              </svg>
            </button>
          </div>
          <div className="jot-settings-body">
            <div className="jot-settings-section">Recording quality</div>
            <div className="jot-quality-grid">
              {QUALITY_PRESET_OPTIONS.map((preset) => (
                <button
                  key={preset.id}
                  className={`jot-quality-btn${quality === preset.id ? ' active' : ''}`}
                  onClick={() => onQualityChange(preset.id)}>
                  <div className="jot-quality-val">{preset.title}</div>
                  <div className="jot-quality-sub">{preset.subtitle}</div>
                </button>
              ))}
            </div>

            <div className="jot-settings-section" style={{ marginTop: 16 }}>
              Encoding engine
            </div>
            <label className="jot-toggle-row">
              <span className="jot-toggle-label">
                <span>Use legacy encoder (MediaRecorder)</span>
                <span className="jot-toggle-desc">
                  {webCodecsSupport === null
                    ? 'Checking...'
                    : webCodecsUnavailable
                      ? 'WebCodecs unavailable on this device — legacy mode required'
                      : webCodecsSupport.hardwareAccelerated
                        ? 'WebCodecs (recommended): GPU-accelerated • faster stop'
                        : 'WebCodecs (recommended): software encoding • faster stop'}
                </span>
              </span>
              <input
                type="checkbox"
                className="jot-toggle-input"
                checked={useLegacyEncoder}
                disabled={webCodecsUnavailable}
                onChange={(e) =>
                  onEncoderBackendChange(e.target.checked ? 'mediarecorder' : 'webcodecs')
                }
              />
              <span className="jot-toggle-switch" />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export function PreflightScreen({
  audioPreflight,
  includeMic,
  onConfirm,
  onBack,
  isBusy,
}: {
  audioPreflight: RecordingSnapshot['audioPreflight'];
  includeMic: boolean;
  onConfirm: () => void;
  onBack: () => void;
  isBusy: boolean;
}) {
  const micOk = includeMic ? audioPreflight.micOk : true;
  const micChecked = includeMic ? audioPreflight.micChecked : true;
  const micClass = includeMic ? (!micChecked ? 'pending' : micOk ? 'ok' : 'fail') : 'ok';
  const micStatus = includeMic
    ? !micChecked
      ? 'Checking...'
      : micOk
        ? 'Active — signal detected'
        : 'Not detected'
    : 'Disabled for this recording';

  return (
    <>
      <div className="jot-body">
        <div className="jot-pf-title">Checking audio</div>
        <div className="jot-pf-sub">
          We verify your audio before every recording so you never start silent.
        </div>

        <div className={`jot-pf-check ${micClass}`}>
          <div className="jot-pf-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke={micOk ? 'var(--jot-grn)' : 'var(--jot-red2)'}
              strokeWidth="1.5"
              strokeLinecap="round">
              <path d="M7 1.5C5 1.5 3.5 3 3.5 5v2.5C3.5 9.5 5 11 7 11s3.5-1.5 3.5-3.5V5C10.5 3 9 1.5 7 1.5z" />
              <path d="M5 12.5h4M7 11v1.5" />
            </svg>
          </div>
          <div className="jot-pf-info">
            <div className="jot-pf-name">Microphone</div>
            <div className="jot-pf-status">{micStatus}</div>
            {includeMic && micOk && <MicLevelBars level={audioPreflight.micLevel} />}
          </div>
        </div>

        <div className="jot-pf-check pending">
          <div className="jot-pf-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="var(--jot-amb)"
              strokeWidth="1.5"
              strokeLinecap="round">
              <rect x="1.5" y="3" width="11" height="8" rx="1.5" />
              <path d="M4.5 10.5v1.5M9.5 10.5v1.5M3 12h8" />
            </svg>
          </div>
          <div className="jot-pf-info">
            <div className="jot-pf-name">System audio</div>
            <div className="jot-pf-status">Verified after capture starts</div>
          </div>
        </div>

        <div style={{ fontSize: 10, color: 'var(--jot-t3)', lineHeight: 1.5, marginTop: 2 }}>
          After you click start, Chrome will open the share picker. The popup may close while you
          choose what to share.
        </div>

        <button className="jot-btn-primary" onClick={onConfirm} disabled={isBusy || (includeMic && !micOk)}>
          Start Recording →
        </button>
        <button className="jot-btn-secondary" onClick={onBack}>
          ← Back
        </button>
      </div>
      <Footer label="Audio check complete" />
    </>
  );
}

export function PreflightErrorScreen({
  audioPreflight,
  errorMessage,
  includeMic,
  onRetry,
  onBack,
  onContinueWithoutMic,
  isBusy,
}: {
  audioPreflight: RecordingSnapshot['audioPreflight'];
  errorMessage: string | null;
  includeMic: boolean;
  onRetry: () => void;
  onBack: () => void;
  onContinueWithoutMic: () => void;
  isBusy: boolean;
}) {
  const { micError } = audioPreflight;

  const micErrorContent: Record<string, { title: string; body: string; action: string; status: string }> = {
    MIC_PERMISSION_DENIED: {
      title: 'Microphone blocked',
      body: 'Chrome has blocked microphone access for this extension. Open Chrome settings and allow microphone access, then try again.',
      action: 'Open microphone settings',
      status: 'Permission denied by Chrome',
    },
    MIC_PERMISSION_PROMPT: {
      title: 'Microphone permission needed',
      body: 'We need microphone access to record audio. Grant access when Chrome prompts you.',
      action: 'Grant microphone access',
      status: 'Permission prompt pending',
    },
    MIC_NOT_FOUND: {
      title: 'No microphone detected',
      body: 'No microphone was found. Please connect a microphone and try again.',
      action: 'Try again',
      status: 'Device not found',
    },
    MIC_IN_USE: {
      title: 'Microphone in use',
      body: 'Your microphone is being used by another application. Close other apps using the mic, then try again.',
      action: 'Try again',
      status: 'In use by another app',
    },
  };

  const captureErrorContent: Record<string, { title: string; body: string; status: string }> = {
    TAB_NOT_CAPTURABLE: {
      title: 'This tab cannot be recorded',
      body: 'Open a regular webpage (http/https) and try again.',
      status: 'Current page is not capturable',
    },
    TAB_CAPTURE_START_FAILED: {
      title: 'Screen capture failed',
      body: 'Could not attach to the current tab. Refresh the tab and try again.',
      status: 'Unable to attach capture stream',
    },
    TAB_CAPTURE_STREAM_UNAVAILABLE: {
      title: 'Screen capture failed',
      body: 'Could not create a capture stream for this tab. Try again.',
      status: 'Capture stream unavailable',
    },
    TAB_NOT_AVAILABLE: {
      title: 'No tab available to record',
      body: 'Focus a browser tab and try again.',
      status: 'No active tab selected',
    },
  };

  const parsedError = (() => {
    if (!errorMessage) return null;
    const match = errorMessage.match(/^([A-Z0-9_]+):\s*(.+)$/s);
    if (!match) return null;
    return {
      code: match[1],
      detail: match[2]?.trim() || null,
    };
  })();

  const isMicSpecificError = Boolean(micError && micErrorContent[micError]);
  const captureInfo = parsedError?.code ? captureErrorContent[parsedError.code] : null;

  const info = isMicSpecificError
    ? micErrorContent[micError ?? '']
    : {
        title: captureInfo?.title ?? 'Capture check failed',
        body:
          parsedError?.detail ??
          captureInfo?.body ??
          errorMessage ??
          'An unexpected error occurred before recording could start. Try again.',
        action: 'Try again',
        status: captureInfo?.status ?? 'Start check failed',
      };

  const errorCode = isMicSpecificError
    ? (micError ?? 'MIC_ERROR')
    : (parsedError?.code ?? 'PRECHECK_ERROR');

  const handleAction = async () => {
    if (isMicSpecificError && micError === 'MIC_PERMISSION_DENIED') {
      void chrome.runtime.sendMessage({ type: 'OPEN_MIC_SETTINGS' });
    } else if (isMicSpecificError && micError === 'MIC_PERMISSION_PROMPT') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        onRetry();
      } catch {
        // permission still denied
      }
    } else {
      onRetry();
    }
  };

  return (
    <>
      <div className="jot-body">
        <div className="jot-pf-title">{info.title}</div>
        <div className="jot-pf-sub" style={{ marginBottom: 12 }}>
          Action required before recording.
        </div>

        <div className="jot-err-box">
          <div className="jot-err-title">{errorCode}</div>
          <div className="jot-err-body">{info.body}</div>
          <button className="jot-err-action" onClick={handleAction} disabled={isBusy}>
            {info.action}
          </button>
        </div>

        <div className="jot-pf-check fail">
          <div className="jot-pf-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="var(--jot-red2)"
              strokeWidth="1.5"
              strokeLinecap="round">
              <path d="M7 1.5C5 1.5 3.5 3 3.5 5v2.5C3.5 9.5 5 11 7 11s3.5-1.5 3.5-3.5V5C10.5 3 9 1.5 7 1.5z" />
              <path d="M5 12.5h4M7 11v1.5" />
            </svg>
          </div>
          <div className="jot-pf-info">
            <div className="jot-pf-name">{isMicSpecificError ? 'Microphone' : 'Screen capture'}</div>
            <div className="jot-pf-status">{info.status}</div>
          </div>
        </div>

        <button className="jot-btn-secondary" onClick={onBack}>
          ← Back
        </button>
        {includeMic && isMicSpecificError && (
          <button className="jot-btn-secondary" onClick={onContinueWithoutMic} disabled={isBusy}>
            Continue without mic
          </button>
        )}
      </div>
      <Footer label="Action required" />
    </>
  );
}

export function ArmedScreen({ onCancel }: { onCancel: () => void }) {
  return (
    <>
      <div className="jot-body">
        <div className="jot-armed-center">
          <div className="jot-armed-icon">
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              stroke="rgba(255,255,255,0.4)"
              strokeWidth="1.4"
              strokeLinecap="round">
              <rect x="2" y="4" width="18" height="12" rx="2" />
              <path d="M8 19h6M11 16v3" />
            </svg>
          </div>
          <div className="jot-armed-title">Choose what to record</div>
          <div className="jot-armed-sub">
            Select a tab, window, or screen from Chrome&apos;s share dialog
          </div>
          <div className="jot-armed-indicator">
            <div className="jot-armed-pulse" />
            <span style={{ fontSize: 11, color: 'var(--jot-t2)' }}>Share picker should be open now</span>
          </div>
        </div>
        <button className="jot-btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <Footer label="Waiting for share selection..." />
    </>
  );
}

export function RecordingScreen({
  snapshot,
  onStop,
  isBusy,
  quality = snapshot.resolvedPreset ?? snapshot.requestedPreset ?? snapshot.recordingQuality,
}: {
  snapshot: RecordingSnapshot;
  onStop: () => void;
  isBusy: boolean;
  quality?: CaptureResolvedQuality;
}) {
  const safeSeconds = snapshot.chunkCount * 10;
  const hasSavedData = snapshot.chunkCount > 0;
  const requestedPreset = snapshot.requestedPreset ?? snapshot.recordingQuality;
  const resolvedPreset = snapshot.resolvedPreset ?? quality;
  const requestedLabel = toCaptureQualityLabel(requestedPreset);
  const resolvedLabel = toResolvedQualityLabel(resolvedPreset);
  const showActualUsed = resolvedPreset !== requestedPreset;

  return (
    <>
      <div className="jot-body-sm">
        {snapshot.micWarningMessage && (
          <div className="jot-storage-warn" style={{ marginBottom: 10 }}>
            <svg viewBox="0 0 12 12" fill="none" strokeWidth="1.4" strokeLinecap="round">
              <path d="M6 1L11 10H1L6 1z" />
              <line x1="6" y1="5" x2="6" y2="7.5" />
              <circle cx="6" cy="9" r="0.5" fill="var(--jot-amb)" stroke="none" />
            </svg>
            <span>{snapshot.micWarningMessage}</span>
          </div>
        )}

        <Timer seconds={snapshot.elapsedSeconds} />
        <Waveform />

        <div className="jot-safety-card">
          <div className="jot-safety-left">
            <div className="jot-safety-icon">
              <svg viewBox="0 0 14 14">
                <path d="M7 1.5L2 4v4.5C2 11.5 4.5 13.5 7 14c2.5-.5 5-2.5 5-5.5V4L7 1.5z" />
                <path d="M4.5 7.5l2 2 3-3.5" />
              </svg>
            </div>
            <div>
              <div className="jot-safety-label">
                {hasSavedData ? 'Saving as you record' : 'Recording in progress'}
              </div>
              <div className="jot-safety-sub">
                {hasSavedData ? '10-second chunks — always recoverable' : 'First save in a few seconds'}
              </div>
            </div>
          </div>
          <div className={`jot-safety-time${hasSavedData ? '' : ' pending'}`}>
            {hasSavedData ? `${safeSeconds}s` : '—'}
          </div>
        </div>

        <div className="jot-quality-row">
          <div className="jot-quality-pill">
            <div className="jot-quality-pill-dot" />
            Requested: {requestedLabel}
          </div>
          {showActualUsed && (
            <div
              className="jot-quality-pill"
              style={{ background: 'rgba(255,214,10,0.14)', color: 'rgba(120,90,10,0.95)' }}>
              <div className="jot-quality-pill-dot" style={{ background: 'rgba(214,153,0,0.95)' }} />
              Actual used: {resolvedLabel}
            </div>
          )}
          {snapshot.webCodecsStats && (
            <div className="jot-quality-pill" style={{ background: 'rgba(52,199,89,0.12)', color: 'rgba(52,199,89,0.9)' }}>
              <div className="jot-quality-pill-dot" style={{ background: 'rgba(52,199,89,0.9)' }} />
              {snapshot.webCodecsStats.hardwareAccelerated ? 'HW Accelerated' : 'Software Encoding'}
              {snapshot.webCodecsStats.bytesWritten > 0 && ` · ${formatBytes(snapshot.webCodecsStats.bytesWritten)}`}
              {snapshot.webCodecsStats.videoBitrateBps != null &&
                snapshot.webCodecsStats.videoBitrateBps > 0 &&
                ` · ${(snapshot.webCodecsStats.videoBitrateBps / 1_000_000).toFixed(1)} Mb/s`}
              {(snapshot.webCodecsStats.memoryPressureTier ?? 0) > 0 && ' · reducing load'}
            </div>
          )}
        </div>

        <button className="jot-btn-stop" disabled={isBusy} onClick={onStop}>
          <StopSquare />
          Stop Recording
        </button>
      </div>
      <Footer label={hasSavedData ? `${safeSeconds}s safely saved` : 'Recording started'} />
    </>
  );
}

export function AudioWarningScreen({
  snapshot,
  onContinueMicOnly,
  onStopRetry,
  onStop,
  isBusy,
}: {
  snapshot: RecordingSnapshot;
  onContinueMicOnly: () => void;
  onStopRetry: () => void;
  onStop: () => void;
  isBusy: boolean;
}) {
  return (
    <>
      <div className="jot-body-sm">
        <div className="jot-rec-indicator">
          <div className="jot-rec-dot" />
          <span className="jot-rec-label">Recording</span>
        </div>

        {snapshot.micWarningMessage && (
          <div className="jot-storage-warn" style={{ marginBottom: 10 }}>
            <svg viewBox="0 0 12 12" fill="none" strokeWidth="1.4" strokeLinecap="round">
              <path d="M6 1L11 10H1L6 1z" />
              <line x1="6" y1="5" x2="6" y2="7.5" />
              <circle cx="6" cy="9" r="0.5" fill="var(--jot-amb)" stroke="none" />
            </svg>
            <span>{snapshot.micWarningMessage}</span>
          </div>
        )}

        <Timer seconds={snapshot.elapsedSeconds} />

        <div className="jot-warn-box">
          <div className="jot-warn-title">System audio not detected</div>
          <div className="jot-warn-body">
            Tab audio is silent. You may have forgotten to enable audio sharing. Continue with mic only,
            or stop and retry.
          </div>
          <div className="jot-warn-btns">
            <button className="jot-warn-btn-p" disabled={isBusy} onClick={onContinueMicOnly}>
              Continue mic only
            </button>
            <button className="jot-warn-btn-s" disabled={isBusy} onClick={onStopRetry}>
              Stop and retry
            </button>
          </div>
        </div>

        <button className="jot-btn-stop" disabled={isBusy} onClick={onStop}>
          <StopSquare />
          Stop Recording
        </button>
      </div>
      <Footer label="Decision required" />
    </>
  );
}

export function StoppingScreen({ snapshot }: { snapshot: RecordingSnapshot }) {
  return (
    <>
      <div className="jot-body">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0 4px' }}>
          <div className="jot-proc-ring-wrap">
            <div className="jot-proc-ring" />
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              stroke="rgba(255,255,255,0.35)"
              strokeWidth="1.4"
              strokeLinecap="round">
              <path d="M8 8h6v6H8z" />
            </svg>
          </div>
          <div className="jot-proc-title">Finalising</div>
          <div className="jot-proc-sub">Writing final chunk to disk. Your recording is safe.</div>
          <div className="jot-priv-note">
            <LockIcon />
            <span>
              {snapshot.chunkCount} chunk{snapshot.chunkCount !== 1 ? 's' : ''} safely saved to your
              device
            </span>
          </div>
        </div>
      </div>
      <Footer label="Saving final chunk..." />
    </>
  );
}

export function ProcessingScreen({
  snapshot,
  phase,
  etaSeconds,
}: {
  snapshot: RecordingSnapshot;
  phase: 'processing' | 'validating';
  etaSeconds: number | null;
}) {
  const progress =
    phase === 'validating' ? 100 : Math.max(0, Math.min(100, snapshot.processingProgress ?? 0));

  const isNearlyDone = progress >= 90 && phase === 'processing';
  const isValidating = phase === 'validating';

  const title = isValidating ? 'Checking your file' : isNearlyDone ? 'Almost done' : 'Converting to MP4';

  const subtitle = isValidating
    ? 'Running a quick validation to make sure everything looks right.'
    : `Encoding ${snapshot.chunkCount} chunk${snapshot.chunkCount !== 1 ? 's' : ''} to H.264. Your recording is safe on disk.`;

  const etaDisplay = (() => {
    if (isValidating) return null;
    if (etaSeconds === null) return null;
    if (etaSeconds <= 0) return null;
    return `~${etaSeconds}s`;
  })();

  const footerLabel = isValidating
    ? 'Validating output...'
    : isNearlyDone
      ? 'Finishing up...'
      : `Converting · ${snapshot.chunkCount} chunk${snapshot.chunkCount !== 1 ? 's' : ''}`;

  return (
    <>
      <div className="jot-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div className="jot-proc-ring-wrap">
          <div className="jot-proc-ring" />
          {isValidating ? (
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              stroke="#9a9aaa"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round">
              <path d="M11 2L4 5.5v5c0 4 3 7.5 7 8.5 4-1 7-4.5 7-8.5v-5L11 2z" />
              <path d="M7.5 11l2.5 2.5 4.5-4.5" />
            </svg>
          ) : (
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              stroke="#9a9aaa"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round">
              <path d="M13 2H6a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-6z" />
              <path d="M13 2v6h6" />
              <path d="M8 13h6M8 17h4" />
            </svg>
          )}
        </div>

        <div className="jot-proc-title">{title}</div>
        <div className="jot-proc-sub">{subtitle}</div>

        <div style={{ width: '100%' }}>
          <div className="jot-prog-track">
            <div className="jot-prog-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="jot-prog-row">
            <span className="jot-prog-pct">{Math.round(progress)}%</span>
            <span className="jot-prog-eta">
              {isValidating ? (
                'Almost there...'
              ) : etaDisplay ? (
                <>
                  <strong>{etaDisplay}</strong> remaining
                </>
              ) : etaSeconds === 0 ? (
                'Finishing...'
              ) : (
                'Estimating...'
              )}
            </span>
          </div>
        </div>

        <div className="jot-priv-note">
          <div className="jot-priv-note-icon">
            <svg viewBox="0 0 12 12" fill="none">
              <rect x="2" y="5" width="8" height="6" rx="1" />
              <path d="M4 5V3.5a2 2 0 114 0V5" />
            </svg>
          </div>
          <span>
            <strong>Stays on your device.</strong> Processing is fully local — your recording is never
            uploaded.
          </span>
        </div>
      </div>

      <Footer label={footerLabel} />
    </>
  );
}

export function DoneScreen({
  snapshot,
  onDownload,
  onRecordAgain,
  isBusy,
}: {
  snapshot: RecordingSnapshot;
  onDownload: () => void;
  onRecordAgain: () => void;
  isBusy: boolean;
}) {
  const metrics = snapshot.processingMetrics;
  const durationSec =
    snapshot.elapsedSeconds > 0
      ? snapshot.elapsedSeconds
      : metrics
        ? Math.round(metrics.inputBytes / 175000)
        : 0;
  const durMin = Math.floor(durationSec / 60);
  const durSec = durationSec % 60;
  const durLabel = durationSec > 0 ? `${durMin}:${String(durSec).padStart(2, '0')}` : '—';
  const sizeLabel = metrics?.outputBytes
    ? formatBytes(metrics.outputBytes)
    : snapshot.webCodecsStats?.bytesWritten
      ? formatBytes(snapshot.webCodecsStats.bytesWritten)
      : '—';
  const requestedPreset = snapshot.requestedPreset ?? snapshot.recordingQuality;
  const resolvedPreset = snapshot.resolvedPreset ?? requestedPreset;
  const requestedLabel = toCaptureQualityLabel(requestedPreset);
  const qualityLabel = toResolvedQualityLabel(resolvedPreset);
  const showFallbackQuality = resolvedPreset !== requestedPreset;

  return (
    <>
      <div className="jot-body">
        <div className="jot-done-head">
          <div className="jot-done-icon">
            <svg viewBox="0 0 16 16" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8l3.5 3.5 6.5-7" />
            </svg>
          </div>
          <div>
            <div className="jot-done-title">Recording ready</div>
            <div className="jot-done-sub">H.264 MP4 · Plays everywhere</div>
          </div>
        </div>

        <div className="jot-done-meta-card">
          <div className="jot-done-meta-top">
            <div className="jot-done-meta-group">
              <div className="jot-done-meta-group-lbl">Duration</div>
              <div className="jot-done-meta-big">{durLabel}</div>
            </div>
            <div className="jot-done-meta-group" style={{ textAlign: 'right' }}>
              <div className="jot-done-meta-group-lbl">File size</div>
              <div className="jot-done-meta-big">{sizeLabel}</div>
            </div>
          </div>

          <div className="jot-done-pills">
            <div className="jot-done-pill">
              <svg viewBox="0 0 10 10">
                <rect x="1" y="1.5" width="8" height="7" rx="1" strokeWidth="1.4" strokeLinecap="round" />
                <polygon points="3.5,3.5 3.5,6.5 7,5" fill="currentColor" stroke="none" />
              </svg>
              {showFallbackQuality ? `Requested: ${requestedLabel}` : qualityLabel}
            </div>
            {showFallbackQuality && (
              <div className="jot-done-pill">Actual: {qualityLabel}</div>
            )}
            <div className="jot-done-pill">
              <svg viewBox="0 0 10 10">
                <path d="M2 5h6M5 2l3 3-3 3" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              H.264 MP4
            </div>
            <div className="jot-done-pill">
              <svg viewBox="0 0 10 10">
                <rect x="2" y="4" width="6" height="4.5" rx="1" strokeWidth="1.4" strokeLinecap="round" />
                <path d="M3.5 4V3a1.5 1.5 0 013 0V4" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              Local only
            </div>
          </div>
        </div>

        {snapshot.validation?.passed && (
          <div className="jot-val-row">
            <svg viewBox="0 0 14 14" fill="none">
              <path d="M7 1.5L2 4v4.5C2 11.5 4.5 13.5 7 14c2.5-.5 5-2.5 5-5.5V4L7 1.5z" />
              <path d="M4.5 7.5l2 2 3-3.5" />
            </svg>
            <span>Validated — video, audio, and duration confirmed</span>
          </div>
        )}

        <button className="jot-btn-download" disabled={isBusy} onClick={onDownload}>
          <svg viewBox="0 0 16 16" fill="none" strokeWidth="2" strokeLinecap="round">
            <path d="M8 2v9M4 8l4 4 4-4" />
            <path d="M2 14h12" />
          </svg>
          Download MP4
        </button>

        <button className="jot-btn-record-again" onClick={onRecordAgain}>
          <svg viewBox="0 0 12 12">
            <circle cx="6" cy="6" r="4.5" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none" />
          </svg>
          Record again
        </button>
      </div>
      <Footer label="MP4 ready to download" />
    </>
  );
}

export function RecoveryScreen({
  snapshot,
  selectedChunks,
  onToggleChunk,
  onProcessSelected,
  onDownloadRaw,
  onClearState,
  isBusy,
}: {
  snapshot: RecordingSnapshot;
  selectedChunks: number[];
  onToggleChunk: (index: number, checked: boolean) => void;
  onProcessSelected: () => void;
  onDownloadRaw: () => void;
  onClearState: () => void;
  isBusy: boolean;
}) {
  return (
    <>
      <div className="jot-body">
        <div className="jot-recovery-box">
          <div className="jot-recovery-title">Processing failed — your data is safe</div>
          <div className="jot-recovery-sub">
            The MP4 could not be validated. Your raw recording chunks are intact on your device. Select
            which chunks to include and try again.
          </div>
          <div className="jot-chunk-list">
            {snapshot.recoveryChunks.map((chunk) => {
              const canInclude = chunk.status !== 'missing';
              const checked = selectedChunks.includes(chunk.index);
              return (
                <div key={chunk.index} className="jot-chunk-item">
                  <input
                    type="checkbox"
                    className="jot-chunk-cb"
                    disabled={!canInclude || isBusy}
                    checked={checked}
                    onChange={(e) => onToggleChunk(chunk.index, e.currentTarget.checked)}
                  />
                  <span className="jot-chunk-name">chunk-{chunk.index}.webm</span>
                  <span className={`jot-chunk-status ${chunk.status}`}>{chunk.status}</span>
                </div>
              );
            })}
          </div>
          <div className="jot-recovery-actions">
            <button
              className="jot-btn-primary"
              style={{ margin: 0, flex: 2, height: 38, fontSize: 11 }}
              disabled={isBusy}
              onClick={onProcessSelected}>
              Process selected
            </button>
            <button
              className="jot-btn-secondary"
              style={{ margin: 0, flex: 1, height: 38 }}
              disabled={isBusy}
              onClick={onDownloadRaw}>
              Download raw
            </button>
          </div>
          <button
            className="jot-btn-secondary"
            style={{ marginTop: 8, height: 34 }}
            disabled={isBusy}
            onClick={onClearState}>
            Clear state
          </button>
        </div>
        {snapshot.sessionId && <div className="jot-session-id">Session: {snapshot.sessionId}</div>}
      </div>
      <Footer label="Validation failed" />
    </>
  );
}

export function ErrorScreen({
  message,
  onRetry,
  isBusy,
}: {
  message: string;
  onRetry: () => void;
  isBusy: boolean;
}) {
  return (
    <>
      <div className="jot-body">
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: '16px 0 12px',
            gap: 10,
            textAlign: 'center',
          }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: 'rgba(255,59,48,0.08)',
              border: '1px solid rgba(255,59,48,0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              stroke="var(--jot-red2)"
              strokeWidth="1.4"
              strokeLinecap="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="11" y1="7" x2="11" y2="12" />
              <circle cx="11" cy="14.5" r="0.8" fill="var(--jot-red2)" stroke="none" />
            </svg>
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--jot-t)', letterSpacing: '-0.02em' }}>
            Something went wrong
          </div>
          <div style={{ fontSize: 11, color: 'var(--jot-t2)', lineHeight: 1.5, maxWidth: 220 }}>{message}</div>
          <button className="jot-btn-primary" style={{ marginTop: 8 }} disabled={isBusy} onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
      <Footer label="Error" />
    </>
  );
}
