# Test Control Plane

This document captures the test-only control plane now wired into Jot's
background worker.

## Summary

The control plane is a background-worker message path that lets automated tests
read recorder state and inject a small amount of fixture data without clicking
through the popup UI.

## File Layout

- `entrypoints/background.ts`
  - routes `TEST_*` runtime messages into the control plane
  - reads the test tab fixture when resolving the active capture target
- `entrypoints/background/testing/control-plane.ts`
  - owns the test-only fixture state
  - handles `TEST_GET_SNAPSHOT`, `TEST_GET_LAST_FILENAME`, `TEST_SET_ACTIVE_TAB`,
    `TEST_GET_PERMISSION_STATE`, `TEST_SET_PERMISSION_STATE`, and
    `TEST_RESET_TEST_FIXTURES`
- `entrypoints/background/testing/gate.ts`
  - central gate for enabling the control plane
  - defaults to `import.meta.env.MODE !== 'production'`
  - also allows a console override through `globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__`
- `lib/testing/permission-fixture.ts`
  - stores the mic permission fixture in `chrome.storage.session`
  - resolves the preflight permission state from the fixture first, then the browser
- `lib/testing/mic-permission.ts`
  - classifies mic request failures so prompt, denied, aborted, not-found, and in-use
    states stay distinct
- `lib/messages.ts`
  - defines the shared `TEST_*` message constants and control-plane response types
- `tests/background-test-control-plane.test.ts`
  - focused coverage for the control plane and restart semantics

## Behavior

- `TEST_GET_SNAPSHOT` returns the live background snapshot.
- `TEST_GET_LAST_FILENAME` returns the resolved public output filename, or
  `null` before a recording has produced one.
- `TEST_SET_ACTIVE_TAB` installs a test-only active-tab fixture used by
  `getStartTargetTab()` when a recording flow needs a stable title and URL.
- `TEST_GET_PERMISSION_STATE` returns the stored mic permission fixture and the
  current active-tab fixture.
- `TEST_SET_PERMISSION_STATE` stores a mic permission fixture in
  `chrome.storage.session` and is meant for deterministic fixture states, not for
  simulating Chrome's native prompt bubble.
- `TEST_RESET_TEST_FIXTURES` clears the active-tab fixture and the session-backed
  permission fixture.
- The control plane is disabled in production builds by default.
- The current implementation treats `outputFileName` as persisted state, so
  `TEST_GET_LAST_FILENAME` rehydrates after a background-worker restart if the
  previous session saved one.
- The permission fixture persists across background-worker restarts because it is
  stored in `chrome.storage.session`, but it clears when Chrome itself closes.
- This path depends on `chrome.storage.session`, so keep the browser floor at
  Chrome 102 or newer if you rely on the fixture in automated or manual tests.
- Native mic permission prompts should be treated as manual browser QA. For
  automated runs that need a granted mic path, launch Chrome with fake media
  flags instead of relying on the popup to hold the prompt open.
- In DevTools, you can flip the live worker on with
  `globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__ = true`, then call
  `globalThis.__JOT_TEST_CONTROL_PLANE__.send({ type: "TEST_GET_SNAPSHOT" })`
  or any other `TEST_*` message from the service-worker console.

## Testing Notes

- Keep the main control-plane tests in one file.
- Prefer a high-fidelity `chrome.runtime.sendMessage` mock that still routes
  through the registered background listener.
- Mock the offscreen client at the message boundary, not by bypassing the
  background worker.
- For manual usage, see [docs/testing/control-plane-repl.md](../testing/control-plane-repl.md).
- For a lower-level fallback when the DevTools UI is flaky, see
  [docs/testing/cdp-service-worker-console.md](../testing/cdp-service-worker-console.md).
- For headed-browser smoke, see [docs/testing/agent-browser-smoke.md](../testing/agent-browser-smoke.md).

## What stays UI-tested

The control plane should not replace all browser testing.

Keep a thin headed-browser lane for:

- popup opens and renders
- start/stop buttons still bind
- visible state matches background state
- recovery UI still appears
- downloads still trigger in a real Chrome session

## Current Scope

Block 1 is intentionally small:

1. gate the control plane
2. read back the live snapshot
3. read back the last filename
4. inject only the active-tab fixture needed for deterministic filename tests
5. add a session-backed permission fixture and reset command

Future blocks can add capture fixtures, start/stop helpers, and orphan/recovery
commands once the readback layer is proven stable.
