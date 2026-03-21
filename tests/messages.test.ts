import { describe, expect, it } from 'vitest';
import { OffscreenEventType, RuntimeMessageType } from '@/lib/messages';

describe('RuntimeMessageType', () => {
  it('keeps critical command/event constants stable', () => {
    expect(RuntimeMessageType.GET_STATE).toBe('GET_STATE');
    expect(RuntimeMessageType.START).toBe('START');
    expect(RuntimeMessageType.STOP).toBe('STOP');
    expect(RuntimeMessageType.STATE_CHANGE).toBe('STATE_CHANGE');
    expect(RuntimeMessageType.OFFSCREEN_STATUS).toBe('OFFSCREEN_STATUS');
    expect(RuntimeMessageType.OFFSCREEN_EVENT).toBe('OFFSCREEN_EVENT');
  });

  it('does not contain duplicate message values', () => {
    const values = Object.values(RuntimeMessageType);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('OffscreenEventType', () => {
  it('keeps expected event constants stable', () => {
    expect(OffscreenEventType.CHUNK_WRITTEN).toBe('CHUNK_WRITTEN');
    expect(OffscreenEventType.FINAL_CHUNK_WRITTEN).toBe('FINAL_CHUNK_WRITTEN');
    expect(OffscreenEventType.PROCESS_PROGRESS).toBe('PROCESS_PROGRESS');
    expect(OffscreenEventType.PROCESS_METRICS).toBe('PROCESS_METRICS');
    expect(OffscreenEventType.ERROR).toBe('ERROR');
  });

  it('does not contain duplicate event values', () => {
    const values = Object.values(OffscreenEventType);
    expect(new Set(values).size).toBe(values.length);
  });
});
