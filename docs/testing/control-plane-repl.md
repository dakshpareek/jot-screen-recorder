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

## Seed the active-tab fixture

Use this when you want deterministic filename resolution without depending on
the real active tab metadata:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_SET_ACTIVE_TAB",
  tab: {
    id: 101,
    title: "Example Domain",
    url: "https://example.com/",
  },
});
```

To return to the real tab flow before using the popup:

```js
await globalThis.__JOT_TEST_CONTROL_PLANE__.send({
  type: "TEST_SET_ACTIVE_TAB",
  tab: null,
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

## Typical block-1 loop

1. Enable the control plane.
2. Read the initial snapshot.
3. Reset and seed the tab and permission fixtures.
4. Run the relevant runtime message or popup action.
5. Read back the snapshot or permission state again.
6. Confirm the result matches the expected fixture-driven outcome.

## Teardown

You can leave the hook enabled for the duration of the session, or set:

```js
globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__ = false;
```
