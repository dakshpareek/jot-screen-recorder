const TEST_CAPTURE_STREAM_PREFIX = 'jot-test-capture:';

export function buildTestCaptureStreamId(targetTabId: number) {
  return `${TEST_CAPTURE_STREAM_PREFIX}${targetTabId}`;
}

export function isTestCaptureStreamId(streamId: string) {
  return streamId.startsWith(TEST_CAPTURE_STREAM_PREFIX);
}
