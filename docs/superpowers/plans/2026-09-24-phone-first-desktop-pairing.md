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

- [ ] Change the shell assertions so the expected bundled URL is `https://voicebridge.heyflint.top/app`, `signInAnonymously` is required, and desktop password/OTP IPC and form controls are forbidden.
- [ ] Run `node --test src/agent/electron/electronShell.test.js`; confirm it fails on the current password-login shell and Pages URL.
- [ ] Change all desktop web-app defaults to `https://voicebridge.heyflint.top/app`.
- [ ] Remove the desktop login panel, password/OTP renderer logic, preload bridges, and IPC handlers. Keep QR refresh, open-web, and unpair controls.
- [ ] Show the exact phone URL plus a copy button in pairing mode; bind the button to `navigator.clipboard.writeText(state.pairingUrl)` with a visible success/error message.
- [ ] Run `node --test src/agent/electron/electronShell.test.js`; confirm the shell tests pass.

### Task 2: Restore anonymous desktop identity and migrate old real-user sessions

**Files:**
- Modify: `src/agent/electron/electronShell.test.js`
- Modify: `src/agent/electron/main.js`

- [ ] Add source-level assertions for: anonymous sign-in on missing session, preservation of valid anonymous sessions, revocation of the local device before signing out a legacy real-user session, and recovery back to pairing rather than a login panel.
- [ ] Run the focused shell test and confirm the new migration assertions fail.
- [ ] In `getOrCreateDesktopClient`, validate an existing session. Clear only stale sessions; do not discard valid anonymous sessions.
- [ ] In initialization, load the device first. If the session is a legacy real user, update this device to `status: 'revoked'`, sign out, create an anonymous session, and continue pairing. If there is no session, call `signInAnonymously()`.
- [ ] Make `SIGNED_OUT` recovery recreate an anonymous session and pairing QR. Ensure intentional migration/sign-out does not race the auth lifecycle handler.
- [ ] Run the focused shell test and confirm it passes.

### Task 3: Add secure pairing status and entitlement resolution

**Files:**
- Modify: `supabase/functions/device-pairing/device-pairing.test.js`
- Modify: `supabase/functions/device-pairing/index.ts`
- Modify: `src/agent/electron/main.js`

- [ ] Add assertions that the Edge Function supports `action === "status"`, filters devices by both device ID and authenticated `runtime_user_id`, and returns normalized `free | pro | admin` without returning email or tokens.
- [ ] Run `node --test supabase/functions/device-pairing/device-pairing.test.js`; confirm the status assertions fail.
- [ ] Implement `getPairingStatus(serviceClient, runtimeUserId, rawDeviceId)`: validate UUID, fetch only the matching runtime device, return `paired: false` for absent/revoked/unclaimed devices, and resolve `admin` from `profiles.is_admin` before active/trialing `pro` subscription status.
- [ ] Replace direct desktop table polling with authenticated `device-pairing` status requests. Pass returned `plan` into `goOnline`, removing anonymous reads of profiles/subscriptions.
- [ ] Run the Edge Function test and focused Electron shell test; confirm both pass.

### Task 4: Preserve claim flow and cover production URL behavior

**Files:**
- Modify: `src/public/auth.test.js`
- Modify: `hosted-pwa/public/auth.test.js`
- Modify: `hosted-pwa/tests/static-build.test.mjs`
- Modify if needed: `src/public/pairing.js`
- Mirror if needed: `hosted-pwa/public/pairing.js`

- [ ] Add assertions that a signed-out phone keeps the pairing query through login, a signed-in phone can claim it, successful claim removes only pairing parameters, and the hosted app route remains `/app`.
- [ ] Run `node --test src/public/auth.test.js hosted-pwa/public/auth.test.js`; confirm any missing behavior fails before production edits.
- [ ] Make the smallest phone-side changes needed to preserve the token through authentication and show the existing confirmation overlay after login.
- [ ] Run the focused phone tests and `cd hosted-pwa && npm test`; confirm mirrored sources and static build pass.

### Task 5: End-to-end verification and deployment readiness

**Files:**
- Review: all modified files
- Update: `docs/superpowers/plans/2026-09-24-phone-first-desktop-pairing.md`

- [ ] Run `npm test` from the repository root.
- [ ] Run `cd hosted-pwa && npm test`.
- [ ] Run `npx supabase functions serve device-pairing --env-file .env` only if the local Supabase environment is available; otherwise record that live verification requires deployment.
- [ ] Build the Electron package with `npm run package`; confirm bundled config uses `https://voicebridge.heyflint.top/app`.
- [ ] Review `git diff --check`, `git diff --stat`, and the full scoped diff for accidental changes or secrets.
- [ ] Do not deploy, publish, commit, or replace the currently installed desktop app unless the user separately authorizes those external actions.
