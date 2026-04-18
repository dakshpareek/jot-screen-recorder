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
- `stopping`
- `processing`
- `validating`
- `done`
- `recovery`
- `error`

Authoritative transition table lives in:
- `entrypoints/background/state/transitions.ts` (`ALLOWED_TRANSITIONS`)

## Popup -> Background Commands
- `GET_STATE`
- `PREPARE_START` (`includeMic`, optional `micDeviceId`, optional `quality`)
- `START` (`audioSource`, optional `micDeviceId`, optional `quality`)
- `STOP`
- `DOWNLOAD`
- `RESET_TO_IDLE`
- `RUN_MIC_CHECK` (optional `micDeviceId`)
- `RELEASE_MIC_CHECK`
- `CANCEL_START`
- `RECOVER_ORPHAN` (`sessionId`, optional `chunkIndexes`)
- `DISCARD_ORPHAN` (`sessionId`)
- `REFRESH_ORPHANS`
- `DOWNLOAD_RAW_CHUNKS` (`sessionId`)
- `OPEN_MIC_SETTINGS`
- `GET_ENCODER_SETTINGS`
- `SET_ENCODER_SETTINGS` (`settings.encoderBackend`)
- `WEBCODECS_CHECK_SUPPORT` (`quality`)

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
- `OFFSCREEN_START_WEBCODECS` (`sessionId`, `streamId`, `quality`, `audioSource`, optional `micDeviceId`)
- `OFFSCREEN_STOP_WEBCODECS`
- `WEBCODECS_CHECK_SUPPORT` (`quality`)

## Async Events
Offscreen -> Background:
- `OFFSCREEN_READY`
- `OFFSCREEN_EVENT`:
  - `CHUNK_WRITTEN`
  - `FINAL_CHUNK_WRITTEN`
  - `PROCESS_PROGRESS`
  - `PROCESS_METRICS`
  - `ERROR`
  - `WEBCODECS_STATS`
- `SYSTEM_AUDIO_OK`
- `SYSTEM_AUDIO_SILENT`
- `SYSTEM_AUDIO_ABSENT`
- `LOW_STORAGE_WARNING`
- `AUTO_STOP_LOW_STORAGE`
- `MIC_MIX_FAILED`
- `WEBCODECS_FATAL_ERROR`

Background -> Popup:
- `STATE_CHANGE` (`snapshot`)

## Snapshot Contract
The popup consumes `RecordingSnapshot` from `lib/recording.ts`.
Fields must remain backward-compatible during refactors.

Quality preset fields:
- `requestedPreset`: user-selected preset (`auto`, `1080p30`, `1080p60`, `4k30`).
- `resolvedPreset`: actual recording preset after runtime fallback (`1080p30`, `1080p60`, `1440p30`, `4k30`, or `null` before start).
- `recordingQuality`: backward-compatible alias of `requestedPreset`.

## Audio Preflight Semantics
- `audioPreflight.systemAudioStatus` is `pending` only when runtime system-audio verification is active (MediaRecorder path with `audioSource` of `both` or `tab`).
- WebCodecs mode does not currently run runtime system-audio verification, so `audioPreflight.systemAudioStatus` remains `idle` unless explicit system-audio runtime signals are added in the future.

## WebCodecs Default Policy (Phase 4.1)
- WebCodecs is default-on for new installs via `DEFAULT_RECORDER_SETTINGS.encoderBackend = "webcodecs"`.
- User preference is honored through `recorder-settings.encoderBackend`.
- Legacy installs using `experimental-flags.useWebCodecs` are migrated on read.
- A global kill switch (`WEBCODECS_KILL_SWITCH_FORCE_LEGACY`) can force MediaRecorder regardless of saved/user flags.
- Start flow is WebCodecs-first with automatic fallback to MediaRecorder if WebCodecs start fails.

## FFmpeg Load Policy (Phase 4.2)
- FFmpeg remains a cold-path dependency for processing/recovery/transcode paths.
- Recording start/happy-path capture does not prewarm FFmpeg.
- `ffmpeg.load()` should only occur from cold paths that require FFmpeg execution.
