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
  - handles `TEST_GET_SNAPSHOT`, `TEST_GET_LAST_FILENAME`, and `TEST_SET_ACTIVE_TAB`
- `entrypoints/background/testing/gate.ts`
  - central gate for enabling the control plane
  - defaults to `import.meta.env.MODE !== 'production'`
  - also allows a console override through `globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__`
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
- The control plane is disabled in production builds by default.
- The current implementation treats `outputFileName` as persisted state, so
  `TEST_GET_LAST_FILENAME` rehydrates after a background-worker restart if the
  previous session saved one.
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

Later blocks can add permission fixtures, capture fixtures, start/stop helpers,
and orphan/recovery commands once the readback layer is proven stable.
