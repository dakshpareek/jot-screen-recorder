import {
  type AudioSource,
  type CaptureQuality,
  RuntimeMessageType,
  type TestActiveTabFixture,
  type TestCaptureFixture,
  type TestControlPlaneResponse,
  type TestOrphanFixture,
  type TestPermissionFixture,
} from '@/lib/messages';
import type { RecordingSnapshot } from '@/lib/recording';
import {
  loadTestCaptureFixture,
  resetTestCaptureFixture,
  saveTestCaptureFixture,
} from '@/lib/testing/capture-fixture';
import {
  loadTestOrphanFixture,
  resetTestOrphanFixture,
  saveTestOrphanFixture,
} from '@/lib/testing/orphan-fixture';
import {
  loadTestPermissionFixture,
  resetTestPermissionFixture,
  saveTestPermissionFixture,
  normalizeTestPermissionState,
} from '@/lib/testing/permission-fixture';
import { isTestControlPlaneEnabled } from './gate';

type TestControlPlaneRuntimeHandlers = {
  prepareStart: (
    includeMic?: boolean,
    micDeviceId?: string | null,
    quality?: CaptureQuality,
  ) => Promise<TestControlPlaneResponse>;
  start: (
    audioSource?: AudioSource,
    micDeviceId?: string | null,
    quality?: CaptureQuality,
  ) => Promise<TestControlPlaneResponse>;
  stop: () => Promise<TestControlPlaneResponse>;
  refreshOrphans: () => Promise<TestControlPlaneResponse>;
  recoverOrphan: (sessionId: string, chunkIndexes?: number[]) => Promise<TestControlPlaneResponse>;
  discardOrphan: (sessionId: string) => Promise<TestControlPlaneResponse>;
  syncOrphanFixture: (
    previousFixture: TestOrphanFixture,
    nextFixture: TestOrphanFixture,
  ) => Promise<TestControlPlaneResponse>;
};

let runtimeHandlers: TestControlPlaneRuntimeHandlers | null = null;
type TestPermissionStateMessage = {
  permissionState?: Partial<TestPermissionFixture> | null;
};

type TestCaptureStateMessage = {
  captureFixture?: TestCaptureFixture | null;
  activeTab?: TestActiveTabFixture | null;
  tab?: TestActiveTabFixture | null;
};

type TestOrphanStateMessage = {
  orphanFixture?: TestOrphanFixture | null;
  sessionId?: string | null;
  chunkIndexes?: unknown[] | null;
};

type TestLifecycleMessage = {
  includeMic?: boolean;
  micDeviceId?: string | null;
  quality?: CaptureQuality;
  audioSource?: AudioSource;
};

export function installTestControlPlaneRuntimeHandlers(handlers: TestControlPlaneRuntimeHandlers) {
  runtimeHandlers = handlers;
}

export async function getTestActiveTabFixture() {
  return (await loadTestCaptureFixture()).activeTab;
}

async function loadControlPlaneFixture() {
  const captureFixture = await loadTestCaptureFixture();
  const orphanFixture = await loadTestOrphanFixture();
  return {
    permissionState: await loadTestPermissionFixture(),
    captureFixture,
    activeTab: captureFixture.activeTab,
    orphanFixture,
  };
}

async function resetControlPlaneFixtures() {
  await Promise.all([
    resetTestPermissionFixture(),
    resetTestCaptureFixture(),
    resetTestOrphanFixture(),
  ]);
}

function getRuntimeHandlers() {
  return runtimeHandlers;
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

  if (message.type === RuntimeMessageType.TEST_GET_CAPTURE_FIXTURE) {
    const captureFixture = await loadTestCaptureFixture();
    return {
      ok: true,
      captureFixture,
      activeTab: captureFixture.activeTab,
    };
  }

  if (message.type === RuntimeMessageType.TEST_GET_ORPHAN_FIXTURE) {
    const orphanFixture = await loadTestOrphanFixture();
    return {
      ok: true,
      orphanFixture,
      snapshot: getSnapshot(),
    };
  }

  if (message.type === RuntimeMessageType.TEST_SET_ACTIVE_TAB) {
    const captureFixture = await saveTestCaptureFixture({
      activeTab: (message as TestCaptureStateMessage).tab ?? (message as TestCaptureStateMessage).activeTab ?? null,
    });
    return {
      ok: true,
      captureFixture,
      activeTab: captureFixture.activeTab,
    };
  }

  if (message.type === RuntimeMessageType.TEST_SET_CAPTURE_FIXTURE) {
    const captureState = message as TestCaptureStateMessage;
    const captureFixture = await saveTestCaptureFixture(
      captureState.captureFixture ?? {
        activeTab: captureState.activeTab ?? captureState.tab ?? null,
      },
    );
    return {
      ok: true,
      captureFixture,
      activeTab: captureFixture.activeTab,
    };
  }

  if (message.type === RuntimeMessageType.TEST_SET_ORPHAN_FIXTURE) {
    const orphanState = message as TestOrphanStateMessage;
    const runtime = getRuntimeHandlers();
    if (!runtime) {
      return {
        ok: false,
        error: 'Test control plane lifecycle handlers are unavailable',
        snapshot: getSnapshot(),
      };
    }

    const previousFixture = await loadTestOrphanFixture();
    const nextFixture = await saveTestOrphanFixture(orphanState.orphanFixture ?? { sessions: [] });
    const result = await runtime.syncOrphanFixture(previousFixture, nextFixture);

    return {
      ...(result ?? { ok: true, snapshot: getSnapshot() }),
      orphanFixture: nextFixture,
    };
  }

  if (message.type === RuntimeMessageType.TEST_GET_PERMISSION_STATE) {
    return {
      ok: true,
      ...(await loadControlPlaneFixture()),
    };
  }

  if (message.type === RuntimeMessageType.TEST_SET_PERMISSION_STATE) {
    const permissionState = message as TestPermissionStateMessage;
    const savedPermissionState = await saveTestPermissionFixture({
      microphone: normalizeTestPermissionState(permissionState.permissionState?.microphone),
    });
    const captureFixture = await loadTestCaptureFixture();
    return {
      ok: true,
      permissionState: savedPermissionState,
      captureFixture,
      activeTab: captureFixture.activeTab,
    };
  }

  if (message.type === RuntimeMessageType.TEST_RESET_TEST_FIXTURES) {
    const runtime = getRuntimeHandlers();
    const orphanFixture = await loadTestOrphanFixture();
    if (runtime) {
      await runtime.syncOrphanFixture(orphanFixture, { sessions: [] });
    }
    await resetControlPlaneFixtures();
    return { ok: true, ...(await loadControlPlaneFixture()) };
  }

  if (message.type === RuntimeMessageType.TEST_REFRESH_ORPHANS) {
    const runtime = getRuntimeHandlers();
    if (!runtime) {
      return {
        ok: false,
        error: 'Test control plane lifecycle handlers are unavailable',
        snapshot: getSnapshot(),
      };
    }
    return await runtime.refreshOrphans();
  }

  if (message.type === RuntimeMessageType.TEST_PREPARE_START) {
    const lifecycle = message as TestLifecycleMessage;
    const runtime = getRuntimeHandlers();
    if (!runtime) {
      return {
        ok: false,
        error: 'Test control plane lifecycle handlers are unavailable',
        snapshot: getSnapshot(),
      };
    }
    return await runtime.prepareStart(
      lifecycle.includeMic !== false,
      lifecycle.micDeviceId ?? null,
      lifecycle.quality,
    );
  }

  if (message.type === RuntimeMessageType.TEST_START_RECORDING) {
    const lifecycle = message as TestLifecycleMessage;
    const runtime = getRuntimeHandlers();
    if (!runtime) {
      return {
        ok: false,
        error: 'Test control plane lifecycle handlers are unavailable',
        snapshot: getSnapshot(),
      };
    }
    return await runtime.start(
      lifecycle.audioSource,
      lifecycle.micDeviceId ?? null,
      lifecycle.quality,
    );
  }

  if (message.type === RuntimeMessageType.TEST_STOP_RECORDING) {
    const runtime = getRuntimeHandlers();
    if (!runtime) {
      return {
        ok: false,
        error: 'Test control plane lifecycle handlers are unavailable',
        snapshot: getSnapshot(),
      };
    }
    return await runtime.stop();
  }

  if (message.type === RuntimeMessageType.TEST_RECOVER_ORPHAN) {
    const orphanState = message as TestOrphanStateMessage;
    const runtime = getRuntimeHandlers();
    if (!runtime) {
      return {
        ok: false,
        error: 'Test control plane lifecycle handlers are unavailable',
        snapshot: getSnapshot(),
      };
    }

    const sessionId = orphanState.sessionId ?? '';
    const chunkIndexes = Array.isArray(orphanState.chunkIndexes)
      ? orphanState.chunkIndexes
          .map((value: unknown) => Number(value))
          .filter((value: number) => Number.isInteger(value) && value >= 0)
      : undefined;

    return await runtime.recoverOrphan(sessionId, chunkIndexes);
  }

  if (message.type === RuntimeMessageType.TEST_DISCARD_ORPHAN) {
    const orphanState = message as TestOrphanStateMessage;
    const runtime = getRuntimeHandlers();
    if (!runtime) {
      return {
        ok: false,
        error: 'Test control plane lifecycle handlers are unavailable',
        snapshot: getSnapshot(),
      };
    }

    const sessionId = orphanState.sessionId ?? '';
    const result = await runtime.discardOrphan(sessionId);
    if (result?.ok) {
      const currentFixture = await loadTestOrphanFixture();
      const nextFixture = {
        sessions: currentFixture.sessions.filter((session) => session.sessionId !== sessionId),
      };
      await saveTestOrphanFixture(nextFixture);
      return {
        ...result,
        orphanFixture: nextFixture,
      };
    }
    return result;
  }

  return {
    ok: false,
    error: `Unsupported test command: ${message.type}`,
    snapshot: getSnapshot(),
  };
}
