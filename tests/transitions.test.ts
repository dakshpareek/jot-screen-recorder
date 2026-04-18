import { describe, expect, it } from 'vitest';
import type { RecordingState } from '@/lib/recording';
import { ALLOWED_TRANSITIONS } from '@/entrypoints/background/state/transitions';

const STATES: RecordingState[] = [
  'idle',
  'preflight',
  'preflight_error',
  'armed',
  'recording',
  'stopping',
  'processing',
  'validating',
  'done',
  'recovery',
  'error',
];

describe('ALLOWED_TRANSITIONS', () => {
  it('covers the full set of recording states', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...STATES].sort());
  });

  it('allows the core happy-path recording flow', () => {
    expect(ALLOWED_TRANSITIONS.idle).toContain('preflight');
    expect(ALLOWED_TRANSITIONS.preflight).toContain('armed');
    expect(ALLOWED_TRANSITIONS.armed).toContain('recording');
    expect(ALLOWED_TRANSITIONS.recording).toContain('stopping');
    expect(ALLOWED_TRANSITIONS.stopping).toContain('processing');
    expect(ALLOWED_TRANSITIONS.processing).toContain('validating');
    expect(ALLOWED_TRANSITIONS.validating).toContain('done');
    expect(ALLOWED_TRANSITIONS.done).toContain('idle');
  });

  it('allows defined error and recovery paths', () => {
    expect(ALLOWED_TRANSITIONS.recording).toContain('error');
    expect(ALLOWED_TRANSITIONS.validating).toContain('recovery');
    expect(ALLOWED_TRANSITIONS.recovery).toContain('idle');
    expect(ALLOWED_TRANSITIONS.error).toEqual(expect.arrayContaining(['idle', 'preflight']));
  });

  it('does not point to unknown states', () => {
    for (const [fromState, toStates] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect(toStates.length, `${fromState} should allow at least one next state`).toBeGreaterThan(0);
      for (const nextState of toStates) {
        expect(STATES, `${fromState} points to unknown target ${nextState}`).toContain(nextState);
      }
    }
  });
});
