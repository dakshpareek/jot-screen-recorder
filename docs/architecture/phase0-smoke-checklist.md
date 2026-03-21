# Phase 0 Smoke Checklist

Run this checklist after any runtime refactor. This is intentionally lightweight and manual.

## Preconditions
- Chrome extension loads successfully.
- Popup opens and shows `idle` state.
- A regular web tab (not chrome://) is active.

## Core Recording
1. Start recording with mic disabled.
2. Confirm state sequence: `preflight` -> `armed` -> `recording`.
3. Wait for at least 2 chunks.
4. Stop recording.
5. Confirm state sequence: `stopping` -> `processing` -> `validating` -> `done`.
6. Download output and verify MP4 is playable.

## Mic Path
1. Enable mic toggle.
2. Confirm mic check resolves to ready (or explicit actionable error).
3. Start recording with mic enabled.
4. Stop and download.
5. Verify output contains audio.

## Recovery Path
1. Start a recording.
2. Force-close extension page/process before normal completion.
3. Re-open popup.
4. Confirm orphan session is listed.
5. Run recover flow and verify processed output is downloadable.

## Failure Guards
1. Trigger mic permission denied and confirm popup remains usable.
2. Trigger start while busy and confirm duplicate starts are blocked.
3. Trigger reset from disallowed states and confirm safe error response.

## Regression Notes
- No uncaught runtime exceptions in background/offscreen console.
- No broken popup layout on repeated open/close.
- No stale download URL errors after multiple recordings.
