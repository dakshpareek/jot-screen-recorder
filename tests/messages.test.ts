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
    expect(RuntimeMessageType.OFFSCREEN_START_WEBCODECS).toBe('OFFSCREEN_START_WEBCODECS');
    expect(RuntimeMessageType.OFFSCREEN_STOP_WEBCODECS).toBe('OFFSCREEN_STOP_WEBCODECS');
    expect(RuntimeMessageType.WEBCODECS_CHECK_SUPPORT).toBe('WEBCODECS_CHECK_SUPPORT');
    expect(RuntimeMessageType.WEBCODECS_FATAL_ERROR).toBe('WEBCODECS_FATAL_ERROR');
    expect(RuntimeMessageType.GET_ENCODER_SETTINGS).toBe('GET_ENCODER_SETTINGS');
    expect(RuntimeMessageType.SET_ENCODER_SETTINGS).toBe('SET_ENCODER_SETTINGS');
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
    expect(OffscreenEventType.WEBCODECS_STATS).toBe('WEBCODECS_STATS');
  });

  it('does not contain duplicate event values', () => {
    const values = Object.values(OffscreenEventType);
    expect(new Set(values).size).toBe(values.length);
  });
});
