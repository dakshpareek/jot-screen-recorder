# Implementation Plan — Message Router Seam (Candidate 2)

## Goal

Replace the two hand-rolled `chrome.runtime.onMessage` if-ladders (background ≈190 lines,
offscreen ≈160 lines) with a single shared **message router**. The router owns the
Chrome MV3 "return `true` to keep the port open" contract and the default error-to-response
mapping exactly once, turning dispatch into a pure, unit-testable map.

This is a **pure dispatch refactor**: no message types change, no wire contract changes,
no UI changes. Behavior is identical; only the location of dispatch logic moves.

### Non-goals

- No per-message-type TypeScript registry (handlers keep their own `message as XMessage` narrowing).
- No changes to the popup (it sends messages; it has no dispatch ladder).
- No merging of background and offscreen handler sets — two independent router instances of one shared class.
- No behavior change to any handler beyond the mechanical extraction described below.

## Design decisions (settled)

1. **Placement:** shared `lib/message-router.ts`. Must stay free of any `lib/ → entrypoints/`
   import, so the router carries its own self-contained error formatter.
2. **TEST_ handling:** a predicate route inside the router (`onMatch`), not a pre-check. One
   dispatch path. Exact-type map is checked before predicate routes; no exact route starts
   with `TEST_`, so current "TEST_ wins" behavior is preserved.
3. **Default error catch:** the router wraps each handler; an *uncaught* rejection becomes
   `{ ok: false, error }`. Handlers needing a custom error shape (e.g. `PREPARE_START`) keep
   their own try/catch and never reach the backstop.
4. **Sequencing:** one plan, two commits — background first (it has the real test harness),
   then offscreen.
5. **Return semantics:** the router inspects the handler's return value at call time —
   `Promise` ⇒ async path (`return true`, `sendResponse` on resolve); non-`Promise` ⇒ sync
   path (`sendResponse(value)`, `return undefined`). This reproduces each branch's existing
   `true`/`undefined` return AND the sync-vs-microtask timing of `sendResponse`.

## Hard constraints (from existing tests)

- `tests/background-start-fallback.test.ts` captures the single listener via
  `chrome.runtime.onMessage.addListener` and invokes it as
  `(message, sender, sendResponse) => void | boolean`. The router's `dispatch` MUST have that
  exact signature and remain the **only** `onMessage` listener registered by background.
- The TEST_ debug hook (`__JOT_TEST_CONTROL_PLANE__`) is a global, not a listener — leave it
  exactly as-is.

## Step 1 — `lib/message-router.ts` (new)

```ts
type Sender = chrome.runtime.MessageSender;
type SendResponse = (response?: unknown) => void;
type Handler = (message: any, sender: Sender) => unknown | Promise<unknown>;

interface MessageRouterOptions {
  /** Formats an uncaught handler rejection into a response payload. */
  formatError?: (error: unknown) => unknown;
}

const defaultFormatError = (error: unknown) => ({
  ok: false,
  error:
    error instanceof Error ? error.message :
    typeof error === 'string' ? error : 'Unknown error',
});

export class MessageRouter {
  private exact = new Map<string, Handler>();
  private predicates: Array<{ match: (type: string) => boolean; handler: Handler }> = [];
  private formatError: (error: unknown) => unknown;

  constructor(options: MessageRouterOptions = {}) {
    this.formatError = options.formatError ?? defaultFormatError;
  }

  on(type: string | string[], handler: Handler): this {
    for (const t of Array.isArray(type) ? type : [type]) this.exact.set(t, handler);
    return this;
  }

  onMatch(match: (type: string) => boolean, handler: Handler): this {
    this.predicates.push({ match, handler });
    return this;
  }

  /** Bind once: chrome.runtime.onMessage.addListener(router.dispatch) */
  dispatch = (message: unknown, sender: Sender, sendResponse: SendResponse): boolean | void => {
    const type = (message as { type?: unknown })?.type;
    if (typeof type !== 'string') return;            // no-type guard → ignore

    const handler =
      this.exact.get(type) ?? this.predicates.find((p) => p.match(type))?.handler;
    if (!handler) return;                            // unknown type → ignore, no response

    let result: unknown;
    try {
      result = handler(message, sender);
    } catch (error) {
      sendResponse(this.formatError(error));         // sync throw
      return;
    }

    if (result instanceof Promise) {
      result.then(sendResponse).catch((e) => sendResponse(this.formatError(e)));
      return true;                                   // async → keep port open
    }
    sendResponse(result);                            // sync responder
    return;                                          // matches GET_STATE-style branches
  };
}
```

Notes:
- `dispatch` is an arrow property so it can be passed directly to `addListener` without binding.
- Handlers may be `any`-typed; they narrow internally exactly as today (non-goal: a typed registry).

## Step 2 — Background adapter (`entrypoints/background.ts`)

Inside `defineBackground(() => { ... })`, replace the entire `chrome.runtime.onMessage.addListener(...)`
block (the ≈190-line ladder) with router construction + registration, then
`chrome.runtime.onMessage.addListener(router.dispatch)`. Leave `tabs.onUpdated`,
`runtime.onInstalled`, and `bootstrap()` untouched.

Registration table (each row = one `router.on(...)` / `router.onMatch(...)`):

| Type(s)                                                        | Handler call (returns the response value)                                  |
|---------------------------------------------------------------|----------------------------------------------------------------------------|
| `onMatch(t => t.startsWith('TEST_'))`                         | `handleTestControlPlaneMessage(message, buildSnapshot, () => outputFileName)` |
| `GET_STATE`                                                   | `() => buildSnapshot()`  *(sync)*                                           |
| `START`                                                       | normalize args → `handleStart(...)`                                         |
| `PREPARE_START`                                               | `handlePrepareStart(...)` — see Step 2a                                     |
| `RUN_MIC_CHECK`                                               | `handleRunMicCheck(normalizeMicDeviceId(message.micDeviceId))`             |
| `RELEASE_MIC_CHECK`                                           | `handleReleaseMicCheck()`                                                   |
| `CANCEL_START`                                                | `handleCancelStart()`                                                       |
| `STOP`                                                        | `handleStop()`                                                              |
| `DOWNLOAD`                                                    | `handleDownload()`                                                          |
| `RESET_TO_IDLE`                                               | `handleResetToIdle()`                                                       |
| `DOWNLOAD_RAW_CHUNKS`                                         | `handleDownloadRawChunks(String(message.sessionId ?? ''))`                 |
| `RECOVER_ORPHAN`                                              | parse `chunkIndexes` → `handleRecoverOrphan(...)`                          |
| `DISCARD_ORPHAN`                                              | `handleDiscardOrphan(String(message.sessionId ?? ''))`                     |
| `REFRESH_ORPHANS`                                             | `handleRefreshOrphans()`                                                    |
| `OPEN_MIC_SETTINGS`                                           | `handleOpenMicSettings()` — see Step 2a                                     |
| `OFFSCREEN_EVENT`                                             | `handleOffscreenEvent(message)`                                            |
| `MIC_MIX_FAILED`                                              | `handleMicMixFailed(message)`                                              |
| `SYSTEM_AUDIO_OK`, `SYSTEM_AUDIO_SILENT`, `SYSTEM_AUDIO_ABSENT` | `handleSystemAudioSignal(message)`                                       |
| `LOW_STORAGE_WARNING`, `AUTO_STOP_LOW_STORAGE`               | `handleStorageSignal(message)`                                             |
| `WEBCODECS_FATAL_ERROR`                                       | `handleWebCodecsFatalError(message.error)`                                |
| `OFFSCREEN_READY`                                             | `() => { offscreenClient.markReady(); return { ok: true }; }`  *(sync)*    |
| `GET_ENCODER_SETTINGS`                                        | `loadRecorderSettings()`                                                   |
| `SET_ENCODER_SETTINGS`                                        | `saveRecorderSettings(message.settings)`                                   |
| `WEBCODECS_CHECK_SUPPORT`                                     | `handleWebCodecsCheckSupport(message.quality)` — see Step 2a               |

### Step 2a — Background handler extractions (behavior-preserving)

These currently live as inline `.catch`/IIFE blocks; extract into named async functions that
**return** the response value (with their try/catch inside) so the router can `sendResponse` it:

- **`handlePrepareStart` wrapper** — current inline `.catch` sets `errorMessage`, calls
  `setState('preflight_error')`, and returns `{ ok: false, error, snapshot: buildSnapshot() }`.
  Move that catch into a thin wrapper (or into `handlePrepareStart` itself) so a normalized
  failure response is returned, never thrown.
- **`handleOpenMicSettings()`** — wraps the `chrome.tabs.create(settingsUrl)` then `{ ok: true }`.
- **`handleWebCodecsCheckSupport(quality)`** — the existing IIFE body: `ensureReadyWithRetry`,
  `offscreenClient.send(...)`, and the catch returning the `{ ok:false, ... , videoSupported:false, ... }`
  shape. Return the value instead of calling `sendResponse`.

Keep `normalizeAudioSource`, `normalizeMicDeviceId`, `normalizeCaptureQuality` calls at the call
sites (or inside the handlers) exactly as today.

## Step 3 — Offscreen adapter (`entrypoints/offscreen-script.ts`)

Inside `defineUnlistedScript(() => { ... })`, replace the `chrome.runtime.onMessage.addListener(...)`
ladder with a second router instance + registration, then `addListener(router.dispatch)`.

The router instance is created **inside** the closure so handlers close over the offscreen
state. The offscreen closures `toErrorMessage` / `toNamedErrorMessage` stay where they are; the
router's default formatter covers only uncaught rejections.

Registration table:

| Type(s)                          | Handler call                                                      |
|----------------------------------|------------------------------------------------------------------|
| `OFFSCREEN_START`                | normalize args → `startRecording(...)`                           |
| `OFFSCREEN_STOP`                 | `stopRecording()`                                                |
| `OFFSCREEN_PROCESS`              | parse `chunkIndexes` → `processRecording(...)`                  |
| `OFFSCREEN_VALIDATE`             | `validateLatestOutput()`                                         |
| `MIC_PREFLIGHT`                  | normalize → `runMicPreflight(...)`                              |
| `OFFSCREEN_RELEASE_PREFLIGHT_MIC`| `() => { releasePreflightMicStream(); return { ok: true }; }` *(sync)* |
| `OFFSCREEN_FORCE_CLEANUP`        | `forceCleanupCapture()`                                          |
| `OFFSCREEN_PAUSE`                | `pauseRecording()`                                               |
| `OFFSCREEN_RESUME`               | `resumeRecording()`                                              |
| `OFFSCREEN_SCAN_ORPHANS`         | `scanOrphanedSessions()`                                         |
| `OFFSCREEN_TEST_SEED_ORPHANS`    | normalize sessions → `seedOrphanedSessions(...)`               |
| `OFFSCREEN_CLEAR_SESSION`        | `clearSessionData(String(msg.sessionId ?? ''))`                |
| `OFFSCREEN_RECOVERY_INSPECT`     | `inspectRecoveryChunks(String(msg.sessionId ?? ''))`           |
| `OFFSCREEN_DOWNLOAD_RAW_CHUNKS`  | `downloadRawChunks(String(msg.sessionId ?? ''))`              |
| `OFFSCREEN_STATUS`               | `() => ({ alive: true, isRecording: ..., ... })` *(sync)*      |
| `WEBCODECS_CHECK_SUPPORT`        | `handleCheckWebCodecsSupport(msg.quality)` — extract from IIFE |
| `OFFSCREEN_START_WEBCODECS`      | `handleStartWebCodecs(msg)` — extract from IIFE (keeps cleanup) |
| `OFFSCREEN_STOP_WEBCODECS`       | `handleStopWebCodecs()` — extract from IIFE (keeps cleanup)    |

### Step 3a — Offscreen handler extractions (behavior-preserving)

Extract the three WebCodecs IIFEs into named async functions returning the response value, each
preserving its existing try/catch + `cleanupMedia()` / `cleanupWebCodecsPipeline()` on error.
The `OFFSCREEN_STATUS` and `OFFSCREEN_RELEASE_PREFLIGHT_MIC` branches become small sync handlers.

## Step 4 — Tests

### New: `tests/message-router.test.ts`

Pure unit tests against `MessageRouter` (no chrome globals needed):

- no `type` → `dispatch` returns `undefined`, no handler called, `sendResponse` not called.
- unknown `type` → returns `undefined`, `sendResponse` not called.
- sync handler → `sendResponse(value)` called synchronously, `dispatch` returns `undefined`.
- async handler → `dispatch` returns `true`, `sendResponse` called after the promise resolves.
- handler rejects → `sendResponse({ ok: false, error })` via default formatter, `dispatch` returns `true`.
- handler throws synchronously → `sendResponse({ ok: false, error })`, returns `undefined`.
- multi-type registration (`on([A, B], h)`) → both dispatch to `h`.
- predicate route (`onMatch`) → matches by prefix; exact route wins over predicate.
- custom `formatError` option is used when provided.

### Must still pass unchanged

- `tests/background-start-fallback.test.ts`
- `tests/background-test-control-plane.test.ts`
- `tests/offscreen-client.test.ts`

## Verification

1. `pnpm compile` — type-check both adapters and the new module.
2. `pnpm test` — full unit suite (new router tests + all survivors green).
3. Optional end-to-end: `pnpm test:live:control-plane` (builds + drives real dispatch over CDP)
   and the smoke checklist in `docs/architecture/phase0-smoke-checklist.md`.

## Sequencing & rollback

- **Commit 1:** `lib/message-router.ts` + `tests/message-router.test.ts` + background adapter
  (Steps 1, 2, 2a, 4-new, plus background survivors). Verify with `pnpm compile && pnpm test`.
- **Commit 2:** offscreen adapter (Steps 3, 3a). Verify again.
- Rollback is per-commit; the router module is additive and inert until an adapter uses it.

## Risk register

| Risk                                                   | Mitigation                                                                 |
|--------------------------------------------------------|----------------------------------------------------------------------------|
| `dispatch` timing differs (sync vs microtask)          | Return-value inspection preserves per-branch timing; covered by router tests + start-fallback. |
| A handler that previously returned `true` now responds sync (or vice-versa) | Mapping tables above keep async handlers async; router derives `true`/`undefined` from the actual return. |
| `PREPARE_START` custom error path lost                  | Folded into the handler/wrapper in Step 2a; returns the same `{ ok, error, snapshot }`. |
| WebCodecs cleanup-on-error dropped                      | IIFE try/catch + cleanup moved verbatim into the extracted functions (Steps 2a/3a). |
| Accidental second `onMessage` listener in background    | Only `router.dispatch` is registered; start-fallback test asserts the single captured listener still works. |
