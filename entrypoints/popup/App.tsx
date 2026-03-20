import { useEffect, useMemo, useState } from 'react';
import { formatDuration, type RecordingSnapshot, type RecordingState } from '@/lib/recording';

const EMPTY_SNAPSHOT: RecordingSnapshot = {
  state: 'idle',
  sessionId: null,
  recordingStartTime: null,
  elapsedSeconds: 0,
  chunkCount: 0,
  processingProgress: null,
  errorMessage: null,
  storageWarningMessage: null,
  canDownload: false,
  outputFileName: null,
  validation: null,
  processingMetrics: null,
  orphanedSessions: [],
  recoverySessionId: null,
  recoveryChunks: [],
  audioPreflight: {
    micChecked: false,
    micOk: false,
    micLevel: null,
    micError: null,
    systemAudioStatus: 'idle',
    systemAudioLevel: null,
    systemAudioMessage: null,
    needsSystemAudioDecision: false,
  },
};

const STARTABLE_STATES: RecordingState[] = [
  'idle',
  'done',
  'preflight_error',
  'recovery',
  'error',
];

export default function App() {
  const [snapshot, setSnapshot] = useState<RecordingSnapshot>(EMPTY_SNAPSHOT);
  const [isBusy, setIsBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [selectedRecoveryChunks, setSelectedRecoveryChunks] = useState<number[]>([]);

  useEffect(() => {
    const listener = (message: unknown) => {
      const payload = message as { type?: string; snapshot?: RecordingSnapshot };
      if (payload.type === 'STATE_CHANGE' && payload.snapshot) {
        setSnapshot(payload.snapshot);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    void refreshState();
    void chrome.runtime.sendMessage({ type: 'REFRESH_ORPHANS' }).catch(() => {});

    const interval = window.setInterval(() => {
      void refreshState();
    }, 1000);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const selected = snapshot.recoveryChunks.filter((chunk) => chunk.included).map((chunk) => chunk.index);
    setSelectedRecoveryChunks(selected);
  }, [snapshot.recoverySessionId, snapshot.recoveryChunks]);

  const statusLine = useMemo(() => {
    if (snapshot.state === 'preflight') {
      return 'Preflight - preparing capture...';
    }
    if (snapshot.state === 'preflight_error') {
      const micErr = snapshot.audioPreflight.micError;
      if (micErr === 'MIC_PERMISSION_DENIED') {
        return 'Microphone blocked — open settings to unblock';
      }
      if (micErr === 'MIC_PERMISSION_PROMPT') {
        return 'Microphone access needed to record audio';
      }
      if (micErr === 'MIC_NOT_FOUND') {
        return 'No microphone detected — please connect one';
      }
      if (micErr === 'MIC_IN_USE') {
        return 'Microphone is in use by another application';
      }
      return 'Preflight failed — check microphone permission';
    }
    if (snapshot.state === 'armed') {
      return 'Armed - waiting for share selection...';
    }
    if (snapshot.state === 'recording') {
      return `Recording - ${formatDuration(snapshot.elapsedSeconds)} elapsed`;
    }
    if (snapshot.state === 'audio_warning') {
      return 'System audio warning - choose continue or stop/retry';
    }
    if (snapshot.state === 'processing') {
      return `Processing - ${snapshot.processingProgress ?? 0}%`;
    }
    if (snapshot.state === 'stopping') {
      return 'Stopping - waiting for final chunk write...';
    }
    if (snapshot.state === 'done') {
      return 'Done - MP4 is ready';
    }
    if (snapshot.state === 'recovery') {
      return 'Recovery - processing output failed validation';
    }
    if (snapshot.state === 'error') {
      return 'Error';
    }
    return 'Idle';
  }, [snapshot]);

  async function refreshState() {
    try {
      const latest = (await chrome.runtime.sendMessage({
        type: 'GET_STATE',
      })) as RecordingSnapshot;
      if (latest) {
        setSnapshot(latest);
      }
    } catch {
      // Background may be waking up.
    }
  }

  async function runCommand(
    type:
      | 'START'
      | 'STOP'
      | 'DOWNLOAD'
      | 'SYSTEM_AUDIO_CONTINUE'
      | 'SYSTEM_AUDIO_STOP_RETRY'
      | 'REFRESH_ORPHANS',
  ) {
    setIsBusy(true);
    setLocalError(null);

    try {
      let payload: Record<string, unknown> = { type };
      if (type === 'START') {
        const prep = (await chrome.runtime.sendMessage({
          type: 'PREPARE_START',
        })) as { ok?: boolean; error?: string; snapshot?: RecordingSnapshot };
        if (prep?.snapshot) {
          setSnapshot(prep.snapshot);
        }
        if (!prep?.ok) {
          setLocalError(prep?.error ?? 'Unable to prepare recording');
          return;
        }
      }

      const result = (await chrome.runtime.sendMessage({
        ...payload,
      })) as { ok?: boolean; error?: string; snapshot?: RecordingSnapshot };

      if (result?.snapshot) {
        setSnapshot(result.snapshot);
      }

      if (!result?.ok) {
        setLocalError(result?.error ?? `Command "${type}" failed`);
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function runOrphanCommand(
    type: 'RECOVER_ORPHAN' | 'DISCARD_ORPHAN',
    sessionId: string,
    chunkIndexes?: number[],
  ) {
    setIsBusy(true);
    setLocalError(null);
    try {
      const result = (await chrome.runtime.sendMessage({
        type,
        sessionId,
        ...(Array.isArray(chunkIndexes) ? { chunkIndexes } : {}),
      })) as { ok?: boolean; error?: string; snapshot?: RecordingSnapshot };

      if (result?.snapshot) {
        setSnapshot(result.snapshot);
      }

      if (!result?.ok) {
        setLocalError(result?.error ?? `Command "${type}" failed`);
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  const canStart = STARTABLE_STATES.includes(snapshot.state);
  const canStop = snapshot.state === 'recording' || snapshot.state === 'audio_warning';
  const orphan = snapshot.orphanedSessions[0] ?? null;
  const recoverySelectionVisible =
    Boolean(snapshot.recoverySessionId) &&
    snapshot.recoveryChunks.length > 0 &&
    snapshot.recoverySessionId === orphan?.sessionId;

  return (
    <div style={{ minWidth: 320, padding: 12, fontFamily: 'sans-serif' }}>
      {orphan && (
        <div
          style={{
            border: '1px solid #f2b500',
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
            background: '#fff8e1',
          }}
        >
          <p style={{ margin: '0 0 4px', fontWeight: 600 }}>Interrupted recording found</p>
          <p style={{ margin: '0 0 8px', fontSize: 12 }}>
            {formatOrphanTimestamp(orphan.startTime)} · {orphan.chunkCount} chunks ·{' '}
            {formatBytes(orphan.totalSize)}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              disabled={isBusy}
              onClick={() => void runOrphanCommand('RECOVER_ORPHAN', orphan.sessionId)}
            >
              Process & Download
            </button>
            <button
              disabled={isBusy}
              onClick={() => void runOrphanCommand('DISCARD_ORPHAN', orphan.sessionId)}
            >
              Discard
            </button>
          </div>
          {recoverySelectionVisible && (
            <div style={{ marginTop: 8, borderTop: '1px solid #e2c16d', paddingTop: 8 }}>
              <p style={{ margin: '0 0 6px', fontSize: 12 }}>
                Suspect chunks detected. Select chunks to include:
              </p>
              <div style={{ display: 'grid', gap: 4, marginBottom: 8 }}>
                {snapshot.recoveryChunks.map((chunk) => {
                  const canInclude = chunk.status !== 'missing';
                  const checked = selectedRecoveryChunks.includes(chunk.index);
                  return (
                    <label
                      key={chunk.index}
                      style={{ fontSize: 12, opacity: canInclude ? 1 : 0.6, display: 'flex', gap: 6 }}
                    >
                      <input
                        type="checkbox"
                        disabled={!canInclude || isBusy}
                        checked={checked}
                        onChange={(event) => {
                          const isChecked = event.currentTarget.checked;
                          setSelectedRecoveryChunks((prev) => {
                            const next = new Set(prev);
                            if (isChecked) next.add(chunk.index);
                            else next.delete(chunk.index);
                            return [...next].sort((a, b) => a - b);
                          });
                        }}
                      />
                      <span>
                        chunk-{chunk.index} · {chunk.status}
                      </span>
                    </label>
                  );
                })}
              </div>
              <button
                disabled={isBusy || selectedRecoveryChunks.length === 0}
                onClick={() =>
                  void runOrphanCommand('RECOVER_ORPHAN', orphan.sessionId, selectedRecoveryChunks)
                }
              >
                Process selected
              </button>
            </div>
          )}
        </div>
      )}

      <p style={{ margin: '0 0 8px' }}>State: {snapshot.state}</p>
      <p style={{ margin: '0 0 8px' }}>{statusLine}</p>
      {snapshot.state === 'preflight_error' && snapshot.audioPreflight.micError && (
        <div style={{ margin: '0 0 12px', padding: 10, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8 }}>
          {snapshot.audioPreflight.micError === 'MIC_PERMISSION_DENIED' && (
            <>
              <p style={{ margin: '0 0 8px', fontSize: 13 }}>
                Chrome has blocked microphone access for this extension. You need to unblock it in Chrome settings, then try again.
              </p>
              <button
                disabled={isBusy}
                onClick={() => {
                  void chrome.runtime.sendMessage({ type: 'OPEN_MIC_SETTINGS' });
                }}
              >
                Open Microphone Settings
              </button>
            </>
          )}
          {snapshot.audioPreflight.micError === 'MIC_PERMISSION_PROMPT' && (
            <>
              <p style={{ margin: '0 0 8px', fontSize: 13 }}>
                We need microphone access to record audio in your screen capture. Click below to grant access, then press Start again.
              </p>
              <button
                disabled={isBusy}
                onClick={async () => {
                  try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    stream.getTracks().forEach((track) => track.stop());
                    setLocalError(null);
                    void runCommand('START');
                  } catch {
                    setLocalError('Microphone permission was not granted');
                  }
                }}
              >
                Grant Microphone Access
              </button>
            </>
          )}
          {snapshot.audioPreflight.micError === 'MIC_NOT_FOUND' && (
            <p style={{ margin: 0, fontSize: 13 }}>
              No microphone was detected. Please connect a microphone and try again.
            </p>
          )}
          {snapshot.audioPreflight.micError === 'MIC_IN_USE' && (
            <p style={{ margin: 0, fontSize: 13 }}>
              Your microphone appears to be in use by another application. Close other apps using the mic, then try again.
            </p>
          )}
        </div>
      )}
      {snapshot.storageWarningMessage && (
        <p style={{ margin: '0 0 8px', color: '#9a6700' }}>
          Storage: {snapshot.storageWarningMessage}
        </p>
      )}
      <p style={{ margin: '0 0 12px' }}>Chunks written: {snapshot.chunkCount}</p>
      {snapshot.audioPreflight.micChecked && (
        <p style={{ margin: '0 0 8px' }}>
          Mic preflight: {snapshot.audioPreflight.micOk ? 'ok' : 'failed'}
          {typeof snapshot.audioPreflight.micLevel === 'number'
            ? ` (level ${formatAudioLevel(snapshot.audioPreflight.micLevel)})`
            : ''}
          {snapshot.audioPreflight.micError ? ` — ${snapshot.audioPreflight.micError}` : ''}
        </p>
      )}
      {snapshot.audioPreflight.systemAudioStatus !== 'idle' && (
        <p style={{ margin: '0 0 12px' }}>
          System audio: {snapshot.audioPreflight.systemAudioStatus}
          {typeof snapshot.audioPreflight.systemAudioLevel === 'number'
            ? ` (level ${formatAudioLevel(snapshot.audioPreflight.systemAudioLevel)})`
            : ''}
          {snapshot.audioPreflight.systemAudioMessage
            ? ` — ${snapshot.audioPreflight.systemAudioMessage}`
            : ''}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button disabled={!canStart || isBusy} onClick={() => void runCommand('START')}>
          Start
        </button>
        <button disabled={!canStop || isBusy} onClick={() => void runCommand('STOP')}>
          Stop
        </button>
        <button
          disabled={!snapshot.canDownload || isBusy}
          onClick={() => void runCommand('DOWNLOAD')}
        >
          Download MP4
        </button>
      </div>

      {snapshot.state === 'audio_warning' && snapshot.audioPreflight.needsSystemAudioDecision && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button disabled={isBusy} onClick={() => void runCommand('SYSTEM_AUDIO_CONTINUE')}>
            Continue mic-only
          </button>
          <button disabled={isBusy} onClick={() => void runCommand('SYSTEM_AUDIO_STOP_RETRY')}>
            Stop and retry
          </button>
        </div>
      )}

      {snapshot.validation && (
        <p style={{ margin: '0 0 8px' }}>
          Validation: {snapshot.validation.passed ? 'passed' : 'failed'} (size:{' '}
          {snapshot.validation.checks.size ? 'ok' : 'fail'}, header:{' '}
          {snapshot.validation.checks.header ? 'ok' : 'fail'}, duration:{' '}
          {snapshot.validation.checks.duration ? 'ok' : 'fail'})
        </p>
      )}

      {snapshot.processingMetrics && (
        <p style={{ margin: '0 0 8px', fontSize: 12, lineHeight: 1.4 }}>
          Processing: {formatMs(snapshot.processingMetrics.totalMs)} total; ffmpeg load{' '}
          {formatMs(snapshot.processingMetrics.ffmpegLoadMs)}; exec{' '}
          {formatMs(snapshot.processingMetrics.execMs)}; chunks {snapshot.processingMetrics.chunkCount}
          ; input {formatBytes(snapshot.processingMetrics.inputBytes)}; output{' '}
          {formatBytes(snapshot.processingMetrics.outputBytes)}; mode {snapshot.processingMetrics.mode}
          ; encode {snapshot.processingMetrics.encodeProfile}
        </p>
      )}

      {(localError || snapshot.errorMessage) && (
        <p style={{ margin: 0, color: '#b3261e' }}>
          Error: {localError ?? snapshot.errorMessage}
        </p>
      )}
    </div>
  );
}

function formatMs(value: number) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatAudioLevel(level: number) {
  if (!Number.isFinite(level) || level <= 0) return '0';
  return `${level.toFixed(level >= 10 ? 0 : 1)}`;
}

function formatOrphanTimestamp(epochMs: number) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'Unknown time';
  return new Date(epochMs).toLocaleString();
}
