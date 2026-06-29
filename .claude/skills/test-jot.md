# test-jot skill

Start a headed Chrome session with the Jot extension loaded from `dist/`,
ready to test on any URL. Use this whenever you need to verify Jot features
in a real browser without the user manually installing anything.

## Setup

Always run these first:

```bash
# 1. Build the latest extension bundle
pnpm build

# 2. If a prior browser daemon is running, close it before relaunching with new options
agent-browser --session jot close

# 3. Open headed Chrome with the extension loaded from the WXT build output
agent-browser --session jot --headed --extension /Users/dakshpareek/personal-projects/screen-recorder/screen-recorder/.output/chrome-mv3 open https://example.com
```

Use `--session jot` consistently so the browser session can be reused across
commands.

## Testing flow

Prefer browser-side smoke tests for the UI and use unit tests for filename and
state logic.

### Core smoke pass

1. Open a capturable page such as `https://example.com`.
2. Open the Jot popup.
3. Verify the popup shows the expected idle or armed state.
4. Start a recording with mic disabled.
5. Verify recording state transitions.
6. Stop the recording.
7. Verify the output is downloadable and the filename is human-friendly.

### Filename checks

Verify:

- the filename starts with `Jot`
- the timestamp is local wall-clock time
- the tab title or host is present when available
- invalid filename characters are not present
- raw exports use the same stem plus `-raw`

### Recovery checks

1. Start a recording.
2. Force an interruption or restart the extension context.
3. Re-open the popup.
4. Verify the orphan/recovery flow appears.
5. Verify raw export and recovery actions still work.

## Screenshots

Use screenshots to capture popup state transitions and recovery UI.

```bash
agent-browser --session jot screenshot /tmp/jot-state.png
```

## Useful commands

```bash
# Open a new page for testing
agent-browser --session jot open https://example.com

# Inspect the current page or popup state
agent-browser --session jot snapshot

# Type into the active page
agent-browser --session jot keyboard type "hello"

# Click a DOM element by snapshot reference
agent-browser --session jot click @eN

# Capture a screenshot
agent-browser --session jot screenshot /tmp/jot.png
```

## Notes

The current browser-UI flow is intentionally thin. Most of the complex
verification should move to the test control plane described in
`docs/architecture/test-control-plane.md` once we decide to implement it.

That control plane would let us test the same flows directly, with less
reliance on popup clicks, permission prompts, and native dialogs.

If Chrome reports `Failed to load extension from: . Manifest file is missing or unreadable`,
the extension path is wrong. Rebuild with `pnpm build` and point `agent-browser`
at `/Users/dakshpareek/personal-projects/screen-recorder/screen-recorder/.output/chrome-mv3`.

## Teardown

```bash
agent-browser --session jot close
```
