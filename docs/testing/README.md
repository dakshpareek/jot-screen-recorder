# Testing

This directory is the home for practical test runbooks.

Use these guides when you want to validate the extension manually:

- [Agent Browser Smoke](./agent-browser-smoke.md)
- [Control Plane REPL](./control-plane-repl.md)
- [CDP Service Worker Console](./cdp-service-worker-console.md)

The REPL guide includes the permission-fixture and reset-first workflow used by
the current test-control-plane phase.
The CDP guide is the lower-level fallback when you want direct worker-context
access for debugging.

Use the architecture docs when you want the design rationale:

- [Test Control Plane](../architecture/test-control-plane.md)
- [Runtime Contract](../architecture/runtime-contract.md)
