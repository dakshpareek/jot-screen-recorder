# Control Plane REPL

Use this guide when you want to inspect the live background worker directly
from DevTools.

The control plane is test-only background state. It is not a popup UI feature.

## Start the browser

Use the normal headed-browser setup first:

```bash
pnpm build
agent-browser --session jot close
agent-browser --session jot --headed --extension /Users/dakshpareek/personal-projects/screen-recorder/screen-recorder/.output/chrome-mv3 open https://example.com
```

## Open the worker console

1. Open `chrome://extensions`.
2. Find Jot.
3. Open the service worker inspector.
4. If the card does not expose the inspection controls yet, enable Developer
   mode once for that browser profile.

That browser-profile step is only needed for inspection. You do not need to
manually install the extension from the extensions page for the normal smoke
path.
If you are using `agent-browser`, keep using the same Chrome profile so the
one-time Developer mode toggle sticks.
If the DevTools worker inspector is flaky, use
[CDP Service Worker Console](./cdp-service-worker-console.md) as the fallback
debug path.

## Enable the control plane

Run this in the service-worker console:

```js
globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__ = true;
```

Then verify the hook is present:

```js
globalThis.__JOT_TEST_CONTROL_PLANE__;
```

## Read back state

Snapshot:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({ type: "TEST_GET_SNAPSHOT" });
```

Last filename:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({ type: "TEST_GET_LAST_FILENAME" });
```

Capture fixture:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_GET_CAPTURE_FIXTURE",
});
```

## Seed the capture fixture

Use this when you want deterministic filename resolution without depending on
the real active-tab metadata:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_SET_CAPTURE_FIXTURE",
  captureFixture: {
    activeTab: {
      id: 101,
      title: "Example Domain",
      url: "https://example.com/",
    },
  },
});
```

To return to the real tab flow before using the popup:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_SET_CAPTURE_FIXTURE",
  captureFixture: {
    activeTab: null,
  },
});
```

## Seed the permission fixture

Reset first so the console session starts from a known baseline:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_RESET_TEST_FIXTURES",
});
```

Set the mic permission fixture:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_SET_PERMISSION_STATE",
  permissionState: {
    microphone: "prompt",
  },
});
```

Read it back:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_GET_PERMISSION_STATE",
});
```

To verify the actual mic preflight path, trigger the runtime check directly:

```js
await chrome.runtime.sendMessage({
  type: "RUN_MIC_CHECK",
});
```

With the fixture set to `prompt` or `denied`, the response should surface the
corresponding mic error without needing to click through the popup first.

`prompt` and `denied` are now distinct in the popup:

- `prompt` shows a pending-permission state
- `denied` shows the blocked-state copy
- `aborted` means the permission request was interrupted, which is common when the
  popup loses focus

For automated "granted" path checks, launch Chrome with:

```bash
--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
```

That gives the browser a mic device and auto-accepts the prompt, which makes the
recording path deterministic. Keep the native prompt as a manual QA check.

## Seed the orphan fixture

Use this when you want deterministic orphan/recovery state without depending on
an actual crash:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_SET_ORPHAN_FIXTURE",
  orphanFixture: {
    sessions: [
      {
        sessionId: "rec_20260630_101500",
        startTime: Date.now() - 120000,
        recordingQuality: "auto",
        recordingResolvedQuality: "1080p30",
        recordingKind: "webcodecs-opfs",
        streamBytesWritten: 1,
      },
    ],
  },
});
```

Refresh the live orphan snapshot:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_REFRESH_ORPHANS",
});
```

Drive the recovery path:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_RECOVER_ORPHAN",
  sessionId: "rec_20260630_101500",
});
```

Or discard it:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_DISCARD_ORPHAN",
  sessionId: "rec_20260630_101500",
});
```

## Typical block-2 loop

1. Enable the control plane.
2. Read the initial snapshot.
3. Reset and seed the capture and permission fixtures.
4. Call `TEST_PREPARE_START`, `TEST_START_RECORDING`, and `TEST_STOP_RECORDING`
   as needed for the flow you are testing.
5. Seed and refresh orphan state if you are testing recovery.
6. Read back the snapshot, capture fixture, orphan fixture, last filename, or
   permission state again.
7. Confirm the result matches the expected fixture-driven outcome.

## Teardown

You can leave the hook enabled for the duration of the session, or set:

```js
globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__ = false;
```
