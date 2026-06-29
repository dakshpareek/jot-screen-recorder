import { describe, expect, it } from 'vitest';
import { classifyMicPermissionRequestError } from '@/lib/testing/mic-permission';
import { mapMicErrorToStatus } from '@/entrypoints/popup/hooks/useMicCaptureCheck';

describe('mic permission error handling', () => {
  it('classifies browser mic request failures by their DOMException name', () => {
    const namedError = (name: string) => Object.assign(new Error(name), { name });

    expect(classifyMicPermissionRequestError(namedError('NotAllowedError'))).toBe('MIC_PERMISSION_DENIED');
    expect(classifyMicPermissionRequestError(namedError('AbortError'))).toBe('MIC_PERMISSION_ABORTED');
    expect(classifyMicPermissionRequestError(namedError('NotFoundError'))).toBe('MIC_NOT_FOUND');
    expect(classifyMicPermissionRequestError(namedError('NotReadableError'))).toBe('MIC_IN_USE');
  });

  it('maps mic error codes to distinct popup statuses', () => {
    expect(mapMicErrorToStatus('MIC_PERMISSION_PROMPT')).toBe('prompt');
    expect(mapMicErrorToStatus('MIC_PERMISSION_DENIED')).toBe('denied');
    expect(mapMicErrorToStatus('MIC_PERMISSION_ABORTED')).toBe('aborted');
    expect(mapMicErrorToStatus('MIC_NOT_FOUND')).toBe('not_found');
    expect(mapMicErrorToStatus('MIC_IN_USE')).toBe('in_use');
    expect(mapMicErrorToStatus(undefined)).toBe('waiting');
  });
});
