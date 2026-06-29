import { RuntimeMessageType, type TestActiveTabFixture, type TestControlPlaneResponse } from '@/lib/messages';
import type { RecordingSnapshot } from '@/lib/recording';
import { isTestControlPlaneEnabled } from './gate';

let activeTabFixture: TestActiveTabFixture | null = null;

function normalizeActiveTabFixture(value: unknown): TestActiveTabFixture | null {
  if (value == null) return null;
  if (typeof value !== 'object') return null;

  const candidate = value as Partial<TestActiveTabFixture>;
  const id = candidate.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return null;
  }

  return {
    id,
    title: typeof candidate.title === 'string' ? candidate.title : candidate.title == null ? null : String(candidate.title),
    url: typeof candidate.url === 'string' ? candidate.url : candidate.url == null ? null : String(candidate.url),
  };
}

export function getTestActiveTabFixture() {
  return activeTabFixture;
}

export type TestControlPlaneDebugHook = {
  send: (
    message: { type: string; [key: string]: unknown },
  ) => Promise<TestControlPlaneResponse>;
};

export function installTestControlPlaneDebugHook(
  getSnapshot: () => RecordingSnapshot,
  getLastFilename: () => string | null,
) {
  const hook: TestControlPlaneDebugHook = {
    async send(message) {
      return await handleTestControlPlaneMessage(message, getSnapshot, getLastFilename);
    },
  };

  (globalThis as typeof globalThis & { __JOT_TEST_CONTROL_PLANE__?: TestControlPlaneDebugHook }).__JOT_TEST_CONTROL_PLANE__ =
    hook;
  return hook;
}

export async function handleTestControlPlaneMessage(
  message: { type: string; [key: string]: unknown },
  getSnapshot: () => RecordingSnapshot,
  getLastFilename: () => string | null,
): Promise<TestControlPlaneResponse> {
  if (!isTestControlPlaneEnabled()) {
    return {
      ok: false,
      error: 'Test control plane is disabled',
      snapshot: getSnapshot(),
    };
  }

  if (message.type === RuntimeMessageType.TEST_GET_SNAPSHOT) {
    return {
      ok: true,
      snapshot: getSnapshot(),
    };
  }

  if (message.type === RuntimeMessageType.TEST_GET_LAST_FILENAME) {
    return {
      ok: true,
      outputFileName: getLastFilename(),
      snapshot: getSnapshot(),
    };
  }

  if (message.type === RuntimeMessageType.TEST_SET_ACTIVE_TAB) {
    activeTabFixture = normalizeActiveTabFixture(message.tab);
    return {
      ok: true,
      activeTab: activeTabFixture,
    };
  }

  return {
    ok: false,
    error: `Unsupported test command: ${message.type}`,
    snapshot: getSnapshot(),
  };
}
