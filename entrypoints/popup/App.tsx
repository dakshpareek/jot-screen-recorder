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
  canDownload: false,
  outputFileName: null,
  validation: null,
  processingMetrics: null,
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

  useEffect(() => {
    const listener = (message: unknown) => {
      const payload = message as { type?: string; snapshot?: RecordingSnapshot };
      if (payload.type === 'STATE_CHANGE' && payload.snapshot) {
        setSnapshot(payload.snapshot);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    void refreshState();

    const interval = window.setInterval(() => {
      void refreshState();
    }, 1000);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      window.clearInterval(interval);
    };
  }, []);

  const statusLine = useMemo(() => {
    if (snapshot.state === 'preflight') {
      return 'Preflight - preparing capture...';
    }
    if (snapshot.state === 'armed') {
      return 'Armed - waiting for share selection...';
    }
    if (snapshot.state === 'recording') {
      return `Recording - ${formatDuration(snapshot.elapsedSeconds)} elapsed`;
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

  async function runCommand(type: 'START' | 'STOP' | 'DOWNLOAD') {
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

  const canStart = STARTABLE_STATES.includes(snapshot.state);
  const canStop = snapshot.state === 'recording';

  return (
    <div style={{ minWidth: 320, padding: 12, fontFamily: 'sans-serif' }}>
      <p style={{ margin: '0 0 8px' }}>State: {snapshot.state}</p>
      <p style={{ margin: '0 0 8px' }}>{statusLine}</p>
      <p style={{ margin: '0 0 12px' }}>Chunks written: {snapshot.chunkCount}</p>

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
