import { describe, expect, it } from 'vitest';
import {
  buildConcatTranscodeArgs,
  buildSingleTranscodeArgs,
  getExpectedMinimumDurationSeconds,
  OUTPUT_VIDEO_CODEC,
  parseProgressFromLog,
} from '@/entrypoints/offscreen/processing/ffmpeg-args';

describe('ffmpeg-args', () => {
  it('builds single-input transcode args ending in output.mp4', () => {
    const args = buildSingleTranscodeArgs('input.webm');
    expect(args.slice(0, 2)).toEqual(['-i', 'input.webm']);
    expect(args).toContain('-c:v');
    expect(args).toContain(OUTPUT_VIDEO_CODEC);
    expect(args.at(-1)).toBe('output.mp4');
    expect(args).not.toContain('concat');
  });

  it('builds concat-demuxer transcode args from list.txt', () => {
    const args = buildConcatTranscodeArgs();
    expect(args.slice(0, 6)).toEqual(['-f', 'concat', '-safe', '0', '-i', 'list.txt']);
    expect(args.at(-1)).toBe('output.mp4');
    // shares the same encode tail as the single path
    expect(args).toContain('+faststart');
    expect(args).toContain('yuv420p');
  });

  it('parses ffmpeg progress from a time= log line', () => {
    expect(parseProgressFromLog('frame=900 time=00:00:30.00 bitrate=1000k', 60)).toBe(50);
    expect(parseProgressFromLog('time=00:01:00.00', 60)).toBe(99); // clamped below 100
    expect(parseProgressFromLog('size=12kB no timing here', 60)).toBeNull();
    expect(parseProgressFromLog('time=00:00:30.00', 0)).toBeNull(); // no duration hint
  });

  it('computes the expected minimum concat duration', () => {
    expect(getExpectedMinimumDurationSeconds(1, 10)).toBe(0);
    expect(getExpectedMinimumDurationSeconds(3, 10)).toBe(15); // (3-1)*10*0.75
    expect(getExpectedMinimumDurationSeconds(2, 10)).toBe(7.5);
  });
});
