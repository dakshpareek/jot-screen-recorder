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
  - handles `TEST_GET_SNAPSHOT`, `TEST_GET_LAST_FILENAME`, `TEST_GET_CAPTURE_FIXTURE`,
    `TEST_GET_ORPHAN_FIXTURE`, `TEST_SET_ACTIVE_TAB`, `TEST_SET_CAPTURE_FIXTURE`,
    `TEST_SET_ORPHAN_FIXTURE`, `TEST_GET_PERMISSION_STATE`,
    `TEST_SET_PERMISSION_STATE`, `TEST_RESET_TEST_FIXTURES`, `TEST_PREPARE_START`,
    `TEST_START_RECORDING`, `TEST_STOP_RECORDING`, `TEST_REFRESH_ORPHANS`,
    `TEST_RECOVER_ORPHAN`, and `TEST_DISCARD_ORPHAN`
- `entrypoints/background/testing/gate.ts`
  - central gate for enabling the control plane
  - defaults to `import.meta.env.MODE !== 'production'`
  - also allows a console override through `globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__`
- `lib/testing/capture-fixture.ts`
  - stores the capture fixture in `chrome.storage.session`
  - persists the test-only active-tab metadata across worker restarts
- `lib/testing/orphan-fixture.ts`
  - stores the orphan fixture in `chrome.storage.session`
  - persists deterministic orphan session seeds across worker restarts
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
- `tests/live/cdp-control-plane-smoke.mjs`
  - live Chrome/CDP smoke that drives the production-built extension worker
    through the deterministic synthetic-stream start/stop path

## Behavior

- `TEST_GET_SNAPSHOT` returns the live background snapshot.
- `TEST_GET_LAST_FILENAME` returns the resolved public output filename, or
  `null` before a recording has produced one.
- `TEST_GET_CAPTURE_FIXTURE` returns the session-backed capture fixture.
- `TEST_GET_ORPHAN_FIXTURE` returns the session-backed orphan fixture.
- `TEST_SET_ACTIVE_TAB` and `TEST_SET_CAPTURE_FIXTURE` install the session-backed
  capture fixture used by `getStartTargetTab()` when a recording flow needs a
  stable title and URL.
- `TEST_SET_ORPHAN_FIXTURE` seeds deterministic orphan records and syncs the
  offscreen OPFS state to match.
- `TEST_GET_PERMISSION_STATE` returns the stored mic permission fixture together
  with the current capture fixture.
- `TEST_SET_PERMISSION_STATE` stores a mic permission fixture in
  `chrome.storage.session` and is meant for deterministic fixture states, not for
  simulating Chrome's native prompt bubble.
- `TEST_REFRESH_ORPHANS`, `TEST_RECOVER_ORPHAN`, and `TEST_DISCARD_ORPHAN`
  call through to the same background recovery handlers used by the popup.
- `TEST_PREPARE_START`, `TEST_START_RECORDING`, and `TEST_STOP_RECORDING`
  call into the same background lifecycle handlers used by the popup flow, but
  through the test-only control plane.
- `TEST_RESET_TEST_FIXTURES` clears the capture, orphan, and session-backed
  permission fixtures.
- The control plane is disabled in production builds by default.
- The current implementation treats `outputFileName` as persisted state, so
  `TEST_GET_LAST_FILENAME` rehydrates after a background-worker restart if the
  previous session saved one.
- The capture fixture and permission fixture persist across background-worker
  restarts because they are stored in `chrome.storage.session`, but they clear
  when Chrome itself closes.
- This path depends on `chrome.storage.session`, so keep the browser floor at
  Chrome 102 or newer if you rely on the fixture in automated or manual tests.
- Native mic permission prompts should be treated as manual browser QA. For
  automated runs that need a granted mic path, launch Chrome with fake media
  flags instead of relying on the popup to hold the prompt open.
- In DevTools, you can flip the live worker on with
  `globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__ = true`, then call
  `globalThis.__JOT_TEST_CONTROL_PLANE__.send({ type: "TEST_GET_SNAPSHOT" })`
  or any other `TEST_*` message from the service-worker console.
- `pnpm test:live:control-plane` runs the same kind of worker-context commands
  automatically through `chrome-remote-interface`. It launches headed Chrome
  with the built extension, reaches the real background service worker over CDP,
  seeds stable capture metadata and orphan state, starts/stops recording with a
  synthetic `jot-test-capture:*` stream, exercises orphan refresh/recover/discard,
  verifies deterministic filename state, and resets fixtures.
- The live CDP smoke is not a replacement for popup or real tab-capture QA: it
  does not click the extension UI, grant Chrome's real capture prompt, prove that
  real page pixels were captured, or verify the download picker.

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

Block 2 extends the test control plane with:

1. a session-backed capture fixture for deterministic recording setup
2. a session-backed orphan fixture for deterministic recovery setup
3. explicit prepare/start/stop lifecycle commands that call the real background
   handlers
4. explicit refresh/recover/discard commands that call the real background
   recovery handlers
5. restart coverage for capture, orphan, and persisted filename state
6. the existing permission fixture and snapshot readbacks from block 1
