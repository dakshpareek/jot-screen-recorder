import type { RecordingState } from '@/lib/recording';

export const ALLOWED_TRANSITIONS: Record<RecordingState, RecordingState[]> = {
  idle: ['preflight', 'error'],
  preflight: ['armed', 'preflight_error', 'error'],
  preflight_error: ['idle', 'preflight', 'error'],
  armed: ['recording', 'preflight_error', 'idle', 'error'],
  recording: ['stopping', 'error'],
  stopping: ['processing', 'done', 'error'], // 'done' added for WebCodecs direct path
  processing: ['validating', 'error'],
  validating: ['done', 'recovery', 'error'],
  done: ['idle', 'preflight', 'error'],
  recovery: ['idle', 'preflight', 'error'],
  error: ['idle', 'preflight'],
};
