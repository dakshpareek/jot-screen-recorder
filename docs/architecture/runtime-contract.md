# Runtime Contract (Frozen Baseline)

This document captures the current runtime contract used by popup, background, and offscreen.
Refactors should preserve these message names and state semantics unless an explicit migration is planned.
Canonical constants/types now live in `lib/messages.ts`.

## State Machine
States:
- `idle`
- `preflight`
- `preflight_error`
- `armed`
- `recording`
- `audio_warning`
- `stopping`
- `processing`
- `validating`
- `done`
- `recovery`
- `error`

Authoritative transition table lives in:
- `entrypoints/background.ts` (`ALLOWED_TRANSITIONS`)

## Popup -> Background Commands
- `GET_STATE`
- `PREPARE_START` (`includeMic`, optional `micDeviceId`)
- `START` (`audioSource`, optional `micDeviceId`)
- `STOP`
- `DOWNLOAD`
- `RESET_TO_IDLE`
- `RUN_MIC_CHECK` (optional `micDeviceId`)
- `RELEASE_MIC_CHECK`
- `CANCEL_START`
- `SYSTEM_AUDIO_CONTINUE`
- `SYSTEM_AUDIO_STOP_RETRY`
- `RECOVER_ORPHAN` (`sessionId`, optional `chunkIndexes`)
- `DISCARD_ORPHAN` (`sessionId`)
- `REFRESH_ORPHANS`
- `DOWNLOAD_RAW_CHUNKS` (`sessionId`)
- `OPEN_MIC_SETTINGS`

## Background -> Offscreen Commands
- `OFFSCREEN_STATUS`
- `OFFSCREEN_START` (`sessionId`, `streamId`, `audioSource`, optional `micDeviceId`)
- `OFFSCREEN_STOP`
- `OFFSCREEN_PROCESS` (`sessionId`, optional `chunkIndexes`)
- `OFFSCREEN_VALIDATE`
- `MIC_PREFLIGHT` (optional `micDeviceId`)
- `OFFSCREEN_RELEASE_PREFLIGHT_MIC`
- `OFFSCREEN_PAUSE`
- `OFFSCREEN_RESUME`
- `OFFSCREEN_SCAN_ORPHANS`
- `OFFSCREEN_RECOVERY_INSPECT` (`sessionId`)
- `OFFSCREEN_DOWNLOAD_RAW_CHUNKS` (`sessionId`)
- `OFFSCREEN_CLEAR_SESSION` (`sessionId`)

## Async Events
Offscreen -> Background:
- `OFFSCREEN_READY`
- `OFFSCREEN_EVENT`:
  - `CHUNK_WRITTEN`
  - `FINAL_CHUNK_WRITTEN`
  - `PROCESS_PROGRESS`
  - `PROCESS_METRICS`
  - `ERROR`
- `SYSTEM_AUDIO_OK`
- `SYSTEM_AUDIO_SILENT`
- `SYSTEM_AUDIO_ABSENT`
- `LOW_STORAGE_WARNING`
- `AUTO_STOP_LOW_STORAGE`
- `MIC_MIX_FAILED`

Background -> Popup:
- `STATE_CHANGE` (`snapshot`)

## Snapshot Contract
The popup consumes `RecordingSnapshot` from `lib/recording.ts`.
Fields must remain backward-compatible during refactors.
