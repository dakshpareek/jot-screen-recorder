# Agent Browser Smoke

Use this guide for normal headed-browser verification of the extension UI and
recording flow.

## Start the browser

From the repo root:

```bash
pnpm build
agent-browser --session jot close
agent-browser --session jot --headed --extension /Users/dakshpareek/personal-projects/screen-recorder/screen-recorder/.output/chrome-mv3 open https://example.com
```

The extension is loaded from the WXT build output. Do not install it manually
from `chrome://extensions` for the normal smoke path.

## Smoke flow

1. Open a regular `https://` page such as `https://example.com`.
2. Open the Jot popup.
3. Confirm the popup renders and the initial state looks sane.
4. Start a recording with mic disabled.
5. Let it run long enough to produce output.
6. Stop the recording.
7. Confirm the Save As filename is human-friendly and starts with `Jot`.
8. Confirm the filename uses the page title when it is useful.
9. Repeat on a page with a weak title so you can verify the host fallback.

## What to verify

- the filename starts with `Jot`
- the timestamp is local wall-clock time
- invalid filename characters are stripped
- the active tab title is preferred when it is useful
- the host is used when the title is not useful
- `saveAs: true` still gives the user control over the download location

## Recovery pass

1. Start a recording.
2. Force an interruption or restart the extension context.
3. Re-open the popup.
4. Verify the orphan or recovery UI appears.
5. Confirm recovery and raw export still work.

## Teardown

```bash
agent-browser --session jot close
```
