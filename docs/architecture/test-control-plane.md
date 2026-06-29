# Test Control Plane

This document captures the idea of a direct test control plane for Jot.
The goal is to reduce browser-UI flake by letting automated tests invoke
extension flows directly instead of depending on popup clicks, permission
prompts, and native dialogs.

## Why this exists

The current extension has a lot of behavior that is hard to observe through
browser automation alone:

- popup UI is a thin shell over background state
- recording flows span background, offscreen, OPFS, and downloads
- permissions and capture prompts are browser-native
- save dialogs are outside the web DOM
- service workers and offscreen documents can be restarted by Chrome

A control plane gives tests a deterministic way to:

- start and stop recordings
- read current state snapshots
- inspect resolved filenames and raw export paths
- inject fixtures for capture, permissions, and tab metadata
- verify recovery and orphan flows without UI timing noise

## Recommended Shape

Prefer a test-only control plane inside the extension rather than a public
network API.

### Preferred interface

- runtime messages handled by the background service worker
- enabled only in dev builds or behind a test flag
- read/write commands for test fixtures and snapshots
- explicit responses for filename, state, and download metadata

### Example commands

- `TEST_GET_SNAPSHOT`
- `TEST_SET_ACTIVE_TAB`
- `TEST_SET_PERMISSION_STATE`
- `TEST_SET_CAPTURE_FIXTURE`
- `TEST_START_RECORDING`
- `TEST_STOP_RECORDING`
- `TEST_DOWNLOAD_OUTPUT`
- `TEST_DOWNLOAD_RAW`
- `TEST_SCAN_ORPHANS`
- `TEST_RECOVER_ORPHAN`
- `TEST_SET_RECORDER_BACKEND`

### Example readbacks

- current recording snapshot
- last resolved export base name
- last resolved output filename
- last raw export base name
- last download request
- orphan session list
- validation result

## What stays UI-tested

The control plane should not replace all browser testing.

Keep a thin browser UI lane for:

- popup opens and renders
- start/stop buttons still bind
- visible state matches background state
- recovery UI still appears
- downloads still trigger in a real Chrome session

That means the automated suite becomes:

1. unit tests for pure logic
2. control-plane tests for most extension behavior
3. one or two headed browser smoke checks for real integration

## What to avoid

- Do not make this a public network API unless there is a real product need.
- Do not depend on Save As dialog text for the main test assertions.
- Do not require real microphone permission for every automated run.
- Do not let the test harness infer state only from screenshots.

## Adoption Path

If we decide to build this later, I would do it in phases:

1. add a test flag and runtime message handler
2. expose snapshot and filename readbacks first
3. add fixture injection for tab metadata and permissions
4. add controlled recording start/stop commands
5. add raw export and recovery commands
6. keep a minimal agent-browser UI smoke lane alongside it

## Decision Points

Pick one of these before implementing:

- UI-only skill: simplest to start, most brittle
- Control-plane-only: most deterministic, but loses real browser coverage
- Hybrid: best balance for this extension

For Jot, the hybrid path is the best fit.

