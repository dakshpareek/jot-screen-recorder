import { useEffect, useRef, useState } from 'react';
import { RuntimeMessageType } from '@/lib/messages';
import type { RecordingSnapshot, RecordingState } from '@/lib/recording';
import { MicToggleCard } from './components/MicToggleCard';
import { useRecorderCommands } from './hooks/useRecorderCommands';
import { useRecorderSnapshot } from './hooks/useRecorderSnapshot';
import {
  ArmedScreen,
  AudioWarningScreen,
  DoneScreen,
  ErrorScreen,
  Header,
  IdleScreen,
  PreflightErrorScreen,
  PreflightScreen,
  ProcessingScreen,
  RecordingScreen,
  RecoveryScreen,
  StoppingScreen,
} from './screens/RecorderScreens';
import './styles/recordkit.css';

const EMPTY_SNAPSHOT: RecordingSnapshot = {
  state: 'idle',
  sessionId: null,
  recordingStartTime: null,
  elapsedSeconds: 0,
  chunkCount: 0,
  processingProgress: null,
  errorMessage: null,
  micWarningMessage: null,
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

const STARTABLE_STATES: RecordingState[] = ['idle', 'done', 'preflight_error', 'recovery', 'error'];

function normalizeMicDeviceIdForPayload(deviceId: string) {
  if (!deviceId || deviceId === 'default') {
    return undefined;
  }
  return deviceId;
}

export default function App() {
  const { snapshot, setSnapshot } = useRecorderSnapshot(EMPTY_SNAPSHOT);
  const { isBusy, send } = useRecorderCommands(setSnapshot);

  const [includeMic, setIncludeMic] = useState(false);
  const [selectedMicDeviceId, setSelectedMicDeviceId] = useState('default');
  const [selectedRecoveryChunks, setSelectedRecoveryChunks] = useState<number[]>([]);
  const [processingStartedAtMs, setProcessingStartedAtMs] = useState<number | null>(null);
  const initializedRecoverySessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (snapshot.state !== 'recovery') {
      initializedRecoverySessionRef.current = null;
      return;
    }

    const sessionKey = snapshot.recoverySessionId ?? snapshot.sessionId;
    if (!sessionKey) {
      return;
    }
    if (initializedRecoverySessionRef.current === sessionKey) {
      return;
    }

    initializedRecoverySessionRef.current = sessionKey;
    const included = snapshot.recoveryChunks.filter((chunk) => chunk.included).map((chunk) => chunk.index);
    setSelectedRecoveryChunks(included);
  }, [snapshot.recoveryChunks, snapshot.recoverySessionId, snapshot.sessionId, snapshot.state]);

  useEffect(() => {
    if (snapshot.state === 'processing') {
      setProcessingStartedAtMs((prev) => prev ?? Date.now());
      return;
    }
    setProcessingStartedAtMs(null);
  }, [snapshot.state]);

  async function handleStart(nextIncludeMicInput?: boolean | unknown) {
    const nextIncludeMic =
      typeof nextIncludeMicInput === 'boolean' ? nextIncludeMicInput : includeMic;

    if (isBusy) {
      return;
    }

    const normalizedMicDeviceId = normalizeMicDeviceIdForPayload(selectedMicDeviceId);

    if (nextIncludeMic && !snapshot.audioPreflight.micOk) {
      return;
    }

    if (!nextIncludeMic) {
      await chrome.runtime
        .sendMessage({ type: RuntimeMessageType.RELEASE_MIC_CHECK })
        .catch(() => {});
    }

    const preparePayload: Record<string, unknown> = {
      includeMic: nextIncludeMic,
    };
    if (nextIncludeMic && normalizedMicDeviceId) {
      preparePayload.micDeviceId = normalizedMicDeviceId;
    }

    const prep = await send(RuntimeMessageType.PREPARE_START, preparePayload);
    if (!prep?.ok) {
      try {
        let latest = (await chrome.runtime.sendMessage({
          type: RuntimeMessageType.GET_STATE,
        })) as RecordingSnapshot | null;
        if (latest?.state !== 'armed') {
          for (let i = 0; i < 8; i += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            latest = (await chrome.runtime.sendMessage({
              type: RuntimeMessageType.GET_STATE,
            })) as RecordingSnapshot | null;
            if (latest?.state === 'armed') {
              break;
            }
          }
        }

        if (latest?.state === 'armed') {
          setSnapshot(latest);
        } else {
          const specificError =
            prep?.error ||
            latest?.errorMessage ||
            (latest?.state === 'preflight'
              ? 'Recorder is still preparing. Please wait a moment and try again.'
              : null);
          window.alert(specificError ?? 'Unable to prepare recording');
          return;
        }
      } catch {
        window.alert(prep?.error ?? 'Unable to prepare recording');
        return;
      }
    }

    const startPayload: Record<string, unknown> = {
      audioSource: nextIncludeMic ? 'both' : 'tab',
    };
    if (nextIncludeMic && normalizedMicDeviceId) {
      startPayload.micDeviceId = normalizedMicDeviceId;
    }

    const start = await send(RuntimeMessageType.START, startPayload);
    if (!start?.ok) {
      window.alert(start?.error ?? 'Unable to start recording');
    }
  }

  async function handleStop() {
    await send(RuntimeMessageType.STOP);
  }

  async function handleDownload() {
    await send(RuntimeMessageType.DOWNLOAD);
  }

  async function handleContinueMicOnly() {
    await send(RuntimeMessageType.SYSTEM_AUDIO_CONTINUE);
  }

  async function handleStopRetry() {
    await send(RuntimeMessageType.SYSTEM_AUDIO_STOP_RETRY);
  }

  async function handleRecoverOrphan(sessionId: string) {
    await send(RuntimeMessageType.RECOVER_ORPHAN, { sessionId });
  }

  async function handleDiscardOrphan(sessionId: string) {
    await send(RuntimeMessageType.DISCARD_ORPHAN, { sessionId });
  }

  async function handleProcessSelected() {
    const targetSessionId =
      snapshot.recoverySessionId ?? snapshot.sessionId ?? snapshot.orphanedSessions[0]?.sessionId ?? null;
    if (!targetSessionId) {
      return;
    }

    const nonMissing = snapshot.recoveryChunks
      .filter((chunk) => chunk.status !== 'missing')
      .map((chunk) => chunk.index);
    const chunkIndexes = selectedRecoveryChunks.length ? selectedRecoveryChunks : nonMissing;

    const result = await send(
      RuntimeMessageType.RECOVER_ORPHAN,
      chunkIndexes.length
        ? {
            sessionId: targetSessionId,
            chunkIndexes,
          }
        : { sessionId: targetSessionId },
    );

    if (!result?.ok) {
      window.alert(result?.error ?? 'Failed to process selected chunks');
    }
  }

  async function handleDownloadRaw() {
    const targetSessionId =
      snapshot.recoverySessionId ?? snapshot.sessionId ?? snapshot.orphanedSessions[0]?.sessionId ?? null;
    if (!targetSessionId) {
      return;
    }

    const result = await send(RuntimeMessageType.DOWNLOAD_RAW_CHUNKS, { sessionId: targetSessionId });
    if (!result?.ok) {
      window.alert(result?.error ?? 'Failed to download raw chunks');
    }
  }

  async function handleClearState() {
    const result = await send(RuntimeMessageType.RESET_TO_IDLE);
    if (!result?.ok) {
      window.alert(result?.error ?? 'Unable to clear recovery state');
    }
  }

  function handleToggleChunk(index: number, checked: boolean) {
    setSelectedRecoveryChunks((prev) => {
      const selected = new Set(prev);
      if (checked) {
        selected.add(index);
      } else {
        selected.delete(index);
      }
      return [...selected].sort((a, b) => a - b);
    });
  }

  function handleSettings() {
    void chrome.runtime.openOptionsPage?.();
  }

  async function handleRecordAgain() {
    const result = await send(RuntimeMessageType.RESET_TO_IDLE);
    if (!result?.ok) {
      window.alert(result?.error ?? 'Unable to reset recorder');
    }
  }

  const { state } = snapshot;
  const orphan = snapshot.orphanedSessions[0] ?? null;
  const canStart = STARTABLE_STATES.includes(state);
  const micReady = !includeMic || (snapshot.audioPreflight.micChecked && snapshot.audioPreflight.micOk);
  const canStartRecording = micReady;
  const startButtonLabel = canStartRecording ? 'Start Recording' : 'Fix microphone to continue';

  const processingProgressValue =
    typeof snapshot.processingProgress === 'number' && Number.isFinite(snapshot.processingProgress)
      ? Math.max(0, Math.min(100, snapshot.processingProgress))
      : null;

  const processingElapsedSeconds =
    processingStartedAtMs === null ? null : Math.max(0, (Date.now() - processingStartedAtMs) / 1000);

  const processingEtaSeconds =
    state === 'processing' &&
    processingStartedAtMs !== null &&
    processingProgressValue !== null &&
    processingProgressValue >= 8 &&
    processingElapsedSeconds !== null
      ? (() => {
          const rawEta =
            processingElapsedSeconds / (processingProgressValue / 100) - processingElapsedSeconds;
          if (!Number.isFinite(rawEta) || rawEta < 0 || rawEta > 300) {
            return null;
          }
          return Math.round(rawEta);
        })()
      : null;

  return (
    <div className="rk-root">
      <Header state={state} onSettings={handleSettings} />

      {state === 'idle' || (state === 'done' && snapshot.orphanedSessions.length > 0) ? (
        <IdleScreen
          micControl={
            <MicToggleCard
              includeMic={includeMic}
              onMicChange={setIncludeMic}
              selectedDeviceId={selectedMicDeviceId}
              onSelectedDeviceIdChange={setSelectedMicDeviceId}
              audioPreflight={snapshot.audioPreflight}
            />
          }
          onStart={handleStart}
          isBusy={isBusy || !canStart}
          canStartRecording={canStartRecording}
          startButtonLabel={startButtonLabel}
          orphan={orphan}
          onRecoverOrphan={handleRecoverOrphan}
          onDiscardOrphan={handleDiscardOrphan}
          storageWarning={snapshot.storageWarningMessage}
        />
      ) : null}

      {state === 'preflight' ? (
        <PreflightScreen
          audioPreflight={snapshot.audioPreflight}
          includeMic={includeMic}
          onConfirm={handleStart}
          onBack={() => setSnapshot((prev) => ({ ...prev, state: 'idle' }))}
          isBusy={isBusy}
        />
      ) : null}

      {state === 'preflight_error' ? (
        <PreflightErrorScreen
          audioPreflight={snapshot.audioPreflight}
          includeMic={includeMic}
          onRetry={handleStart}
          onBack={() => setSnapshot((prev) => ({ ...prev, state: 'idle' }))}
          onContinueWithoutMic={() => {
            setIncludeMic(false);
            void handleStart(false);
          }}
          isBusy={isBusy}
        />
      ) : null}

      {state === 'armed' ? (
        <ArmedScreen onCancel={() => void send(RuntimeMessageType.CANCEL_START)} />
      ) : null}

      {state === 'recording' ? (
        <RecordingScreen snapshot={snapshot} onStop={handleStop} isBusy={isBusy} />
      ) : null}

      {state === 'audio_warning' ? (
        <AudioWarningScreen
          snapshot={snapshot}
          onContinueMicOnly={handleContinueMicOnly}
          onStopRetry={handleStopRetry}
          onStop={handleStop}
          isBusy={isBusy}
        />
      ) : null}

      {state === 'stopping' ? <StoppingScreen snapshot={snapshot} /> : null}

      {state === 'processing' || state === 'validating' ? (
        <ProcessingScreen
          snapshot={snapshot}
          phase={state}
          etaSeconds={state === 'processing' ? processingEtaSeconds : null}
        />
      ) : null}

      {state === 'done' && snapshot.orphanedSessions.length === 0 ? (
        <DoneScreen
          snapshot={snapshot}
          onDownload={handleDownload}
          onRecordAgain={handleRecordAgain}
          isBusy={isBusy}
        />
      ) : null}

      {state === 'recovery' ? (
        <RecoveryScreen
          snapshot={snapshot}
          selectedChunks={selectedRecoveryChunks}
          onToggleChunk={handleToggleChunk}
          onProcessSelected={handleProcessSelected}
          onDownloadRaw={handleDownloadRaw}
          onClearState={handleClearState}
          isBusy={isBusy}
        />
      ) : null}

      {state === 'error' ? (
        <ErrorScreen
          message={snapshot.errorMessage ?? 'An unexpected error occurred.'}
          onRetry={handleStart}
          isBusy={isBusy}
        />
      ) : null}
    </div>
  );
}
