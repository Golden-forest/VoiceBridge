# VoiceBridge project map

- Read `README.md` for setup, architecture and release order.
- Author shared phone UI in `src/public`; keep corresponding `hosted-pwa/public` mirrors aligned. Hosted `/app.html` corresponds to local `index.html`; shared import paths differ. The hosted build enforces these invariants.
- Desktop identity and Electron lifecycle: `src/agent`. LAN, ASR transport and the shared input queue: `src/server`. Contracts: `src/shared`.
- Cloud functions and append-only schema changes: `supabase/functions`, `supabase/migrations`. `supabase/config.toml` is the deployment manifest; `scripts/edge-functions.mjs` validates it.
- Never put service/provider secrets in client config or packages. Tests inject system output/provider/auth stubs and must not touch real clipboard, keyboard, billing or user accounts.
- Offline aggregate: `./scripts/verify` (nonzero on any required failure).
- Runtime: Node.js 22.18+ (22.x) or 24+; tests require native TypeScript support.
- Real isolated SQL regression: `VOICEBRIDGE_TEST_POSTGRES=1 ./scripts/verify`. Set `VOICEBRIDGE_POSTGRES_BIN` when PostgreSQL binaries are outside `/opt/homebrew/opt/postgresql@15/bin`; without opt-in SQL is explicitly skipped.
- Source tests: `npm test` (serial, excludes generated/mirrored copies). Run a single test via `npm test -- --test-name-pattern="<name>"` (args pass through to the runner). Avoid invoking `node --test <file>` directly from agent shells: environment instrumentation has been observed to wedge its child processes intermittently; the `npm test` path spawns identically but has not reproduced the hang.
- Hosted build/check: `npm --prefix hosted-pwa test`.
- Mobile web preparation/check: `npm run mobile:prepare && npm --prefix mobile test`.
- JS lint: N/A, no configured linter. Use behavior tests and `node --check` for changed JS.
- Cloud typecheck: `deno check --frozen supabase/functions/transcribe/index.ts supabase/functions/account-delete/index.ts supabase/functions/paddle-webhook/index.ts supabase/functions/stripe-webhook/index.ts supabase/functions/billing-create-checkout-session/index.ts supabase/functions/issue-asr-request/index.ts supabase/functions/report-asr-result/index.ts` (may need registry network).
- Browser check: `node scripts/browser-fixture.mjs`, then manually open `http://127.0.0.1:3123/app`; use its simulated identity/delayed ASR controls. Verify phone dimensions, authentication/target changes, delayed ASR, recording double-click, and console errors. Static mobile tests and fixtures do not prove native permission or real microphone behavior.
- Production status: `node scripts/verify-production.mjs` is read-only by default. Its explicit write-probe option is outside offline verification.
- Do not deploy/commit/publish without authorization. Migrations first, then matching Edge Functions and new desktop/PWA; retired Direct ASR endpoints return 410, so old desktops require upgrade.
