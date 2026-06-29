import type { TestPermissionFixture, TestPermissionState } from '@/lib/messages';

const PERMISSION_FIXTURE_KEY = 'jot-test-permission-fixture';

const DEFAULT_PERMISSION_FIXTURE: TestPermissionFixture = {
  microphone: 'unset',
};

function normalizePermissionState(value: unknown): TestPermissionState {
  if (
    value === 'unset' ||
    value === 'prompt' ||
    value === 'granted' ||
    value === 'denied'
  ) {
    return value;
  }
  return 'unset';
}

function normalizePermissionFixture(value: unknown): TestPermissionFixture {
  if (value == null || typeof value !== 'object') {
    return { ...DEFAULT_PERMISSION_FIXTURE };
  }

  const candidate = value as Partial<TestPermissionFixture>;
  return {
    microphone: normalizePermissionState(candidate.microphone),
  };
}

export async function loadTestPermissionFixture(): Promise<TestPermissionFixture> {
  const stored = await chrome.storage.session.get(PERMISSION_FIXTURE_KEY);
  return normalizePermissionFixture(stored[PERMISSION_FIXTURE_KEY]);
}

export async function saveTestPermissionFixture(
  fixture: Partial<TestPermissionFixture>,
): Promise<TestPermissionFixture> {
  const normalized = normalizePermissionFixture(fixture);
  await chrome.storage.session.set({ [PERMISSION_FIXTURE_KEY]: normalized });
  return normalized;
}

export async function resetTestPermissionFixture(): Promise<void> {
  await chrome.storage.session.remove(PERMISSION_FIXTURE_KEY);
}

export async function resolveMicrophonePermissionState(): Promise<TestPermissionState | PermissionState> {
  const fixture = await loadTestPermissionFixture();
  if (fixture.microphone !== 'unset') {
    return fixture.microphone;
  }

  try {
    const permissionStatus = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return permissionStatus.state;
  } catch {
    return 'unset';
  }
}

export function normalizeTestPermissionState(value: unknown): TestPermissionState {
  return normalizePermissionState(value);
}

