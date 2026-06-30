# Testing

This directory is the home for practical test runbooks.

Use these guides when you want to validate the extension manually:

- [Agent Browser Smoke](./agent-browser-smoke.md)
- [Control Plane REPL](./control-plane-repl.md)
- [CDP Service Worker Console](./cdp-service-worker-console.md)

Use this command when you want the automated live-worker control-plane smoke:

```bash
pnpm test:live:control-plane
```

That command builds the extension, launches a headed Chrome session with the
extension loaded, reaches the real background service worker through CDP, and
runs the deterministic test-only prepare/start/stop path with a synthetic stream.
It does not click the popup, grant Chrome's real tab-capture prompt, or prove a
real-page visual capture/download flow.

The REPL guide includes the permission-fixture and reset-first workflow used by
the current test-control-plane phase.
The CDP guide is the lower-level fallback when you want direct worker-context
access for debugging.

Use the architecture docs when you want the design rationale:

- [Test Control Plane](../architecture/test-control-plane.md)
- [Runtime Contract](../architecture/runtime-contract.md)
