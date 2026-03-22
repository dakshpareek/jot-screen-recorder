import type { RecordingSnapshot } from '@/lib/recording';

export function createSnapshot(overrides: Partial<RecordingSnapshot> = {}): RecordingSnapshot {
  return {
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
    requestedPreset: 'auto',
    resolvedPreset: null,
    recordingQuality: 'auto',
    validation: null,
    processingMetrics: null,
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
    orphanedSessions: [],
    recoverySessionId: null,
    recoveryChunks: [],
    ...overrides,
  };
}
