# CDP Service Worker Console

Use this guide when you need direct, low-level access to Jot's live extension
background worker and the normal DevTools service-worker inspector is awkward,
flaky, or unavailable.

This is a debugging fallback, not the primary QA path. The primary human-facing
paths are:

- [Agent Browser Smoke](./agent-browser-smoke.md)
- [Control Plane REPL](./control-plane-repl.md)

## What this is for

The Chrome DevTools Protocol lets you attach to the running browser process and
evaluate JavaScript in the extension service worker context. That gives you the
same class of access as the service-worker console in DevTools, but without
needing to click through the DevTools UI.

For the repeatable automated version of this flow, run:

```bash
pnpm test:live:control-plane
```

That script uses `chrome-remote-interface` to connect to the real extension
service worker, enables the test control plane, seeds stable capture metadata,
seeds deterministic orphan state, and runs `TEST_PREPARE_START`,
`TEST_START_RECORDING`, `TEST_GET_LAST_FILENAME`, `TEST_STOP_RECORDING`,
`TEST_REFRESH_ORPHANS`, `TEST_RECOVER_ORPHAN`, `TEST_DISCARD_ORPHAN`, and reset
assertions against the live worker.
CDP is only the remote-control channel; the extension still owns the background
and offscreen recording path.

Use it to:

- enable the live test control plane
- inspect background state during a restart
- read and write test fixtures
- verify offscreen/background message flow
- debug stale captures or permission issues in the live browser

## When to use it

Use the CDP path when:

- the service-worker console is hard to reach through the browser UI
- the worker reloads before you can inspect it
- you want to run a short debug probe without changing application code
- you need to check the worker and popup in the same live Chrome session

Do not treat it as a replacement for the normal UI smoke tests.

The automated CDP smoke also does not prove Chrome's real tab-capture permission
gate, popup button wiring, real page pixels, or download UI. It proves that the
real extension runtime can execute the deterministic test-only recording path in
live Chrome.

## Prerequisites

- A headed Jot browser session is already running.
- The extension is loaded from `.output/chrome-mv3`.
- You can open `chrome://extensions` and see Jot in the profile.
- Developer mode is enabled for that browser profile if Chrome requires it for
  inspecting the extension card.

## Typical flow

1. Open the browser session with the extension loaded.
2. Open `chrome://extensions` and make sure Jot is present.
3. Open the popup once if you need to wake the service worker.
4. Get the browser DevTools websocket URL from the session.
5. Attach to the extension service-worker target.
6. Evaluate the code you need in that worker context.

## What to evaluate

Examples:

```js
globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__ = true;
```

```js
globalThis.__JOT_TEST_CONTROL_PLANE__;
```

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_GET_SNAPSHOT",
});
```

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_SET_PERMISSION_STATE",
  permissionState: {
    microphone: "prompt",
  },
});
```

```js
await chrome.runtime.sendMessage({
  type: "RUN_MIC_CHECK",
});
```

## What to verify

- `TEST_GET_SNAPSHOT` reflects the real background snapshot.
- `TEST_GET_PERMISSION_STATE` and `TEST_SET_PERMISSION_STATE` agree with the
  live fixture storage.
- `RUN_MIC_CHECK` returns the expected mic-specific error for the current
  fixture state.
- `TEST_GET_ORPHAN_FIXTURE`, `TEST_SET_ORPHAN_FIXTURE`, `TEST_REFRESH_ORPHANS`,
  `TEST_RECOVER_ORPHAN`, and `TEST_DISCARD_ORPHAN` agree with the live recovery
  path and OPFS-backed orphan state.
- A reload or worker restart preserves the session-backed permission fixture.

## Debug notes

- The service worker context is the right place for control-plane messages and
  background state.
- The offscreen document is the right place for the actual media capture work.
- If a fixture changes in the worker but not in the popup, the problem is
  usually message flow or reload timing, not the fixture itself.
- If the popup is active but the worker target disappears, wake the extension
  again by opening the popup or reloading the extension card.

## Related docs

- [Control Plane REPL](./control-plane-repl.md)
- [Agent Browser Smoke](./agent-browser-smoke.md)
- [Test Control Plane](../architecture/test-control-plane.md)
