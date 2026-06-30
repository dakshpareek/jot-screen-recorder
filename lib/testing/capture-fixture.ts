import type { TestActiveTabFixture, TestCaptureFixture } from '@/lib/messages';

const CAPTURE_FIXTURE_KEY = 'jot-test-capture-fixture';

const DEFAULT_CAPTURE_FIXTURE: TestCaptureFixture = {
  activeTab: null,
};

export function normalizeTestActiveTabFixture(value: unknown): TestActiveTabFixture | null {
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

function normalizeCaptureFixture(value: unknown): TestCaptureFixture {
  if (value == null || typeof value !== 'object') {
    return { ...DEFAULT_CAPTURE_FIXTURE };
  }

  const candidate = value as Partial<TestCaptureFixture> & {
    activeTab?: unknown;
    tab?: unknown;
  };

  return {
    activeTab: normalizeTestActiveTabFixture(candidate.activeTab ?? candidate.tab),
  };
}

export async function loadTestCaptureFixture(): Promise<TestCaptureFixture> {
  const stored = await chrome.storage.session.get(CAPTURE_FIXTURE_KEY);
  return normalizeCaptureFixture(stored[CAPTURE_FIXTURE_KEY]);
}

export async function saveTestCaptureFixture(
  fixture: Partial<TestCaptureFixture> | null | undefined,
): Promise<TestCaptureFixture> {
  const normalized = normalizeCaptureFixture(fixture);
  await chrome.storage.session.set({ [CAPTURE_FIXTURE_KEY]: normalized });
  return normalized;
}

export async function resetTestCaptureFixture(): Promise<void> {
  await chrome.storage.session.remove(CAPTURE_FIXTURE_KEY);
}
