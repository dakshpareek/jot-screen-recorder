/**
 * Pure FFmpeg argument builders and progress/duration math for the processing
 * path. Kept browser-free so the encode-command shape and progress parsing are
 * unit-testable without loading the wasm runtime.
 */

export const OUTPUT_VIDEO_CODEC = 'libx264';
export const OUTPUT_VIDEO_PRESET = 'fast';
export const OUTPUT_VIDEO_CRF = '22';
export const OUTPUT_FRAME_RATE = '30';
export const FFMPEG_AUDIO_BITRATE = '128k';

const SHARED_ENCODE_TAIL = [
  '-vsync',
  'cfr',
  '-r',
  OUTPUT_FRAME_RATE,
  '-c:v',
  OUTPUT_VIDEO_CODEC,
  '-preset',
  OUTPUT_VIDEO_PRESET,
  '-crf',
  OUTPUT_VIDEO_CRF,
  '-c:a',
  'aac',
  '-b:a',
  FFMPEG_AUDIO_BITRATE,
  '-movflags',
  '+faststart',
  '-pix_fmt',
  'yuv420p',
  'output.mp4',
];

/** Transcode a single input file to `output.mp4`. */
export function buildSingleTranscodeArgs(inputFile: string): string[] {
  return ['-i', inputFile, ...SHARED_ENCODE_TAIL];
}

/** Concat-demux a `list.txt` of MP4 chunks into `output.mp4`. */
export function buildConcatTranscodeArgs(listFile = 'list.txt'): string[] {
  return ['-f', 'concat', '-safe', '0', '-i', listFile, ...SHARED_ENCODE_TAIL];
}

/**
 * Parse an FFmpeg `time=HH:MM:SS.xx` log line into a 0–99 progress percentage,
 * or `null` when the line carries no usable timing for the given duration hint.
 */
export function parseProgressFromLog(logLine: string, durationHint: number): number | null {
  if (!durationHint || !logLine.includes('time=')) return null;
  const match = logLine.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const ss = Number(match[3]);
  const seconds = hh * 3600 + mm * 60 + ss;
  const progress = Math.floor((seconds / durationHint) * 100);
  return Math.max(0, Math.min(99, progress));
}

/** Minimum acceptable output duration (seconds) for a multi-chunk concat. */
export function getExpectedMinimumDurationSeconds(chunkCount: number, chunkDurationSeconds: number) {
  if (chunkCount <= 1) return 0;
  return Math.max(1, (chunkCount - 1) * chunkDurationSeconds * 0.75);
}
