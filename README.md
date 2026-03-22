# Screen Recorder (WXT + React)

Local-first Chrome extension screen recorder with:
- Popup UI orchestration
- Background state machine and lifecycle control
- Offscreen capture + processing pipeline
- OPFS worker-backed chunk persistence

## Runtime Architecture
- `entrypoints/popup/*`: UI screens, hooks, commands
- `entrypoints/background.ts`: runtime coordinator (uses modular services/state)
- `entrypoints/background/services/*`: offscreen lifecycle client
- `entrypoints/background/state/*`: transitions and persisted context contract
- `entrypoints/offscreen-script.ts`: offscreen recorder + ffmpeg pipeline
- `entrypoints/offscreen/storage/*`: OPFS worker bridge
- `workers/opfs-worker.ts`: OPFS sync access worker
- `lib/recording.ts`: domain snapshot/types
- `lib/messages.ts`: runtime message constants and shared message types

## Development
- `pnpm dev`: run extension dev mode
- `pnpm compile`: type-check only
- `pnpm build`: production build

## Refactor Safety
- Smoke checklist: `docs/architecture/phase0-smoke-checklist.md`
- Runtime contract baseline: `docs/architecture/runtime-contract.md`

## Privacy Policy URL (Chrome Web Store)
- Policy text (Markdown): `docs/privacy-policy.md`
- Hosted page (HTML): `docs/privacy-policy.html`

To publish this as a URL:
1. In GitHub repo settings, open `Pages`.
2. Set source to `Deploy from a branch`.
3. Choose branch `main` and folder `/docs`.

Then use:
- `https://<your-github-username>.github.io/<repo-name>/privacy-policy.html`
