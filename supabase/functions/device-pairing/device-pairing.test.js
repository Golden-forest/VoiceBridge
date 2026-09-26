import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../../migrations/0004_device_pairing.sql", import.meta.url), "utf8");
const securityMigration = await readFile(
  new URL("../../migrations/20260925091247_secure_device_and_realtime_authorization.sql", import.meta.url),
  "utf8"
);
const additionalPairingMigration = await readFile(
  new URL("../../migrations/20260926143000_same_account_additional_pairing.sql", import.meta.url),
  "utf8"
);

test("device pairing uses authenticated one-time tokens without transferring phone sessions", () => {
  assert.match(source, /userData\.user\.is_anonymous/);
  assert.match(source, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.doesNotMatch(source, /refresh_token/);
  assert.doesNotMatch(source, /access_token/);
});

test("device pairing claim is atomic and restricted to service role", () => {
  assert.match(migration, /function public\.claim_device_pairing/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /grant execute on function public\.claim_device_pairing\(text, uuid\) to service_role/);
  assert.match(migration, /revoke all on public\.device_pairings from anon, authenticated/);
});

test("desktop status is scoped to its runtime identity and returns only normalized entitlement", () => {
  assert.match(source, /body\.action === "status"/);
  assert.match(source, /getPairingStatus\(serviceClient, userData\.user\.id, body\.device_id\)/);
  assert.match(source, /\.eq\("runtime_user_id", runtimeUserId\)/);
  assert.match(source, /\.select\("plan,status"\)/);
  assert.match(source, /plan:\s*"admin"/);
  assert.match(source, /plan:\s*"pro"/);
  assert.match(source, /plan:\s*"free"/);
  assert.doesNotMatch(source, /statusResponse[\s\S]*email/);
  assert.doesNotMatch(source, /statusResponse[\s\S]*access_token/);
  assert.doesNotMatch(source, /statusResponse[\s\S]*refresh_token/);
});

test("device ownership columns and Realtime topics are server-authorized", () => {
  assert.match(securityMigration, /grant update \(name, platform, app_version, status, last_seen_at, updated_at\)/);
  assert.doesNotMatch(securityMigration, /grant update \([^)]*user_id/);
  assert.match(securityMigration, /create schema if not exists private/);
  assert.match(securityMigration, /security definer/);
  assert.match(securityMigration, /p_topic = 'device:' \|\| target\.user_id \|\| ':' \|\| target\.id/);
  assert.match(securityMigration, /actor\.paired_at is not null/);
  assert.doesNotMatch(securityMigration, /using \(extension = 'broadcast'\);/);
});

test("an online desktop can issue another QR only for the same account", () => {
  assert.match(source, /body\.action === "start_additional"/);
  assert.match(source, /body\.action === "cancel_additional"/);
  assert.match(source, /\.eq\("runtime_user_id", runtimeUserId\)/);
  assert.match(source, /additional_pairing_pending/);
  assert.match(additionalPairingMigration, /device_owner_id <> p_user_id/);
  assert.match(additionalPairingMigration, /device_paired_at is not null and device_owner_id <> p_user_id/);
  assert.match(additionalPairingMigration, /for update of pairing/);
});
