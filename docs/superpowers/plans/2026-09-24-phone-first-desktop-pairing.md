# Phone-First Desktop Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phone the only account-login surface: the desktop immediately shows a QR code for `https://voicebridge.heyflint.top/app`, and comes online after the signed-in phone claims it.

**Architecture:** Restore the existing anonymous Supabase runtime identity on desktop, keep the real user session on the phone, and link both identities through the existing one-time `device-pairing` token. Extend the Edge Function with a runtime-authenticated `status` action so the anonymous desktop can learn only its binding state and normalized entitlement without gaining access to profile or billing rows.

**Tech Stack:** Electron, Node.js test runner, Supabase Auth/Postgres/Edge Functions (Deno), Cloudflare Pages PWA.

---

Commits are intentionally omitted because repository instructions prohibit committing unless the user explicitly requests it.

### Task 1: Lock the public URL and desktop-only QR UX

**Files:**
- Modify: `src/agent/electron/electronShell.test.js`
- Modify: `scripts/write-electron-config.js`
- Modify: `src/agent/electron/desktop-config.json`
- Modify: `src/agent/electron/main.js`
- Modify: `src/agent/electron/renderer.html`
- Modify: `src/agent/electron/preload.cjs`

- [x] Change the shell assertions so the expected bundled URL is `https://voicebridge.heyflint.top/app`, `signInAnonymously` is required, and desktop password/OTP IPC and form controls are forbidden.
- [x] Run `node --test src/agent/electron/electronShell.test.js`; confirm it fails on the current password-login shell and Pages URL.
- [x] Change all desktop web-app defaults to `https://voicebridge.heyflint.top/app`.
- [x] Remove the desktop login panel, password/OTP renderer logic, preload bridges, and IPC handlers. Keep QR refresh, open-web, and unpair controls.
- [x] Show the exact phone URL plus a copy button in pairing mode; copy through a narrow Electron clipboard IPC bridge and show a visible success/error message.
- [x] Run `node --test src/agent/electron/electronShell.test.js`; confirm the shell tests pass.

### Task 2: Restore anonymous desktop identity and migrate old real-user sessions

**Files:**
- Modify: `src/agent/electron/electronShell.test.js`
- Modify: `src/agent/electron/main.js`

- [x] Add source-level assertions for: anonymous sign-in on missing session, preservation of valid anonymous sessions, revocation of the local device before signing out a legacy real-user session, and recovery back to pairing rather than a login panel.
- [x] Run the focused shell test and confirm the new migration assertions fail.
- [x] In `getOrCreateDesktopClient`, validate an existing session. Clear only stale sessions; do not discard valid anonymous sessions.
- [x] In initialization, load the device first. If the session is a legacy real user, update this device to `status: 'revoked'`, sign out, create an anonymous session, and continue pairing. If there is no session, call `signInAnonymously()`.
- [x] Make `SIGNED_OUT` recovery recreate an anonymous session and pairing QR. Ensure intentional migration/sign-out does not race the auth lifecycle handler.
- [x] Run the focused shell test and confirm it passes.

### Task 3: Add secure pairing status and entitlement resolution

**Files:**
- Modify: `supabase/functions/device-pairing/device-pairing.test.js`
- Modify: `supabase/functions/device-pairing/index.ts`
- Modify: `src/agent/electron/main.js`

- [x] Add assertions that the Edge Function supports `action === "status"`, filters devices by both device ID and authenticated `runtime_user_id`, and returns normalized `free | pro | admin` without returning email or tokens.
- [x] Run `node --test supabase/functions/device-pairing/device-pairing.test.js`; confirm the status assertions fail.
- [x] Implement `getPairingStatus(serviceClient, runtimeUserId, rawDeviceId)`: validate UUID, fetch only the matching runtime device, return `paired: false` for absent/revoked/unclaimed devices, and resolve `admin` from `profiles.is_admin` before active/trialing `pro` subscription status.
- [x] Replace direct desktop table polling with authenticated `device-pairing` status requests. Pass returned `plan` into `goOnline`, removing anonymous reads of profiles/subscriptions.
- [x] Run the Edge Function test and focused Electron shell test; confirm both pass.

### Task 4: Preserve claim flow and cover production URL behavior

**Files:**
- Modify: `src/public/auth.test.js`
- Modify: `hosted-pwa/public/auth.test.js`
- Modify: `hosted-pwa/tests/static-build.test.mjs`
- Modify if needed: `src/public/pairing.js`
- Mirror if needed: `hosted-pwa/public/pairing.js`

- [x] Add assertions that a signed-out phone keeps the pairing query through login, a signed-in phone can claim it, successful claim removes only pairing parameters, and the hosted app route remains `/app`.
- [x] Run `node --test src/public/auth.test.js hosted-pwa/public/auth.test.js`; confirm the missing redirect behavior fails before production edits.
- [x] Make the smallest phone-side changes needed to preserve the token through authentication and show the existing confirmation overlay after login.
- [x] Run the focused phone tests and `cd hosted-pwa && npm test`; confirm mirrored sources and static build pass.

### Task 5: End-to-end verification and deployment

**Files:**
- Review: all modified files
- Update: `docs/superpowers/plans/2026-09-24-phone-first-desktop-pairing.md`

- [x] Run `npm test` from the repository root (322 tests passed).
- [x] Run `cd hosted-pwa && npm test` (11 tests passed).
- [x] Deploy `device-pairing` to the VoiceBridge Supabase project and verify the authenticated `status` action against production.
- [x] Build the Electron package with `npm run package`; confirm both generated and packaged config use `https://voicebridge.heyflint.top/app`.
- [x] Review `git diff --check`, `git diff --stat`, and the full scoped diff for accidental changes or secrets.
- [x] After explicit user authorization, deploy the hosted PWA to the production Pages project, replace the installed macOS app with a verified matching build, and preserve a timestamped backup.
- [x] Complete the live QR flow with the admin account; verify the desktop reaches `online` with admin/LAN entitlement.

### Task 6: Align LAN ASR entitlement with the paired phone account

**Files:**
- Modify: `src/agent/electron/main.js`
- Modify: `src/server/createLanServer.js`
- Modify: `src/server/asr/directEdgeAsr.js`
- Modify: `supabase/functions/_shared/direct_asr.ts`
- Modify: `src/public/app.js`
- Mirror: `hosted-pwa/public/app.js`
- Update the corresponding focused tests.

- [x] Send the bound desktop `device_id` with LAN ASR issue and result-report requests.
- [x] Resolve the effective billing user only after the service-role Edge path verifies `device_id`, authenticated `runtime_user_id`, active status, and `paired_at`.
- [x] Keep ordinary cloud requests unchanged: requests without `device_id` continue to use the authenticated phone account directly.
- [x] Close the actual `processing` usage row on direct-ASR reports instead of filtering for the nonexistent `reserved` status.
- [x] Retry one transient signing transport/5xx failure, while preserving deterministic 4xx entitlement errors.
- [x] Record LAN audio directly as 16 kHz mono WAV so the desktop skips ffmpeg conversion.
- [x] Run the complete root test suite (327 passed) and package the macOS arm64 app successfully.
- [x] Inspect the packaged `app.asar`: custom-domain `/app` URL, device delegation, and LAN WAV path are present.
- [x] Deploy `issue-asr-request` and `report-asr-result`, then install and verify the new desktop package against the production admin account.
