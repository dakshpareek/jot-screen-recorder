export type MicPermissionRequestErrorCode =
  | 'MIC_PERMISSION_DENIED'
  | 'MIC_PERMISSION_ABORTED'
  | 'MIC_NOT_FOUND'
  | 'MIC_IN_USE';

export function classifyMicPermissionRequestError(error: unknown): MicPermissionRequestErrorCode | null {
  if (!(error instanceof Error)) {
    return null;
  }

  if (error.name === 'NotAllowedError') {
    return 'MIC_PERMISSION_DENIED';
  }

  if (error.name === 'AbortError') {
    return 'MIC_PERMISSION_ABORTED';
  }

  if (error.name === 'NotFoundError') {
    return 'MIC_NOT_FOUND';
  }

  if (error.name === 'NotReadableError') {
    return 'MIC_IN_USE';
  }

  return null;
}
