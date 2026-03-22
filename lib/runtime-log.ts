const DEBUG_LOG_FLAG = '__RECORDKIT_DEBUG_LOGS__';

function debugEnabled() {
  return (globalThis as Record<string, unknown>)[DEBUG_LOG_FLAG] === true;
}

export function debugInfo(...args: unknown[]) {
  if (!debugEnabled()) return;
  console.info(...args);
}

export function debugWarn(...args: unknown[]) {
  if (!debugEnabled()) return;
  console.warn(...args);
}
