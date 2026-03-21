import { describe, expect, it } from 'vitest';
import { formatDuration } from '@/lib/recording';

describe('formatDuration', () => {
  it('clamps negative values to 0', () => {
    expect(formatDuration(-1)).toBe('0:00');
  });

  it('floors fractional seconds', () => {
    expect(formatDuration(0.99)).toBe('0:00');
    expect(formatDuration(61.8)).toBe('1:01');
  });

  it('formats minute and second boundaries correctly', () => {
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(61)).toBe('1:01');
    expect(formatDuration(3605)).toBe('60:05');
  });
});
