import { describe, expect, it } from 'vitest';
import { buildTestCaptureStreamId, isTestCaptureStreamId } from '@/lib/testing/capture-stream';

describe('capture stream test ids', () => {
  it('builds and recognizes the test capture stream prefix', () => {
    const streamId = buildTestCaptureStreamId(123);

    expect(streamId).toBe('jot-test-capture:123');
    expect(isTestCaptureStreamId(streamId)).toBe(true);
    expect(isTestCaptureStreamId('stream-123')).toBe(false);
  });
});
