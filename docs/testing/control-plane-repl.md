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

## Typical block-1 loop

1. Enable the control plane.
2. Read the initial snapshot.
3. Seed the tab fixture.
4. Start and stop a real recording from the popup.
5. Read `TEST_GET_LAST_FILENAME` again.
6. Confirm the persisted filename matches the stem you expected.

## Teardown

You can leave the hook enabled for the duration of the session, or set:

```js
globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__ = false;
```
