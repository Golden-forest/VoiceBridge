import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
const migration = await readFile(
  new URL("../../migrations/0007_reserve_and_get_plan.sql", import.meta.url),
  "utf8"
);
const planFixMigration = await readFile(
  new URL("../../migrations/0009_fix_plan_limits.sql", import.meta.url),
  "utf8"
);
const hardeningMigration = await readFile(
  new URL("../../migrations/0010_harden_user_commands.sql", import.meta.url),
  "utf8"
);

test("transcribe reserves usage and resolves plan in one RPC", () => {
  assert.match(source, /\.rpc\("reserve_and_get_plan"/);
  assert.doesNotMatch(source, /\.from\("subscriptions"\)/);
  assert.match(source, /PLAN_CACHE_TTL_MS = 60_000/);
});

test("transcribe verifies JWT claims without an unconditional getUser round trip", () => {
  assert.match(source, /auth\.getClaims\(accessToken\)/);
  assert.doesNotMatch(source, /auth\.getUser\(\)/);
});

test("reserve_and_get_plan is service-role only and indexed for its filters", () => {
  assert.match(migration, /security invoker/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /subscriptions_user_updated_at_idx/);
  assert.match(migration, /usage_events_user_created_at_idx/);
  assert.match(migration, /to service_role/);
  assert.match(migration, /from public, anon, authenticated/);
});

test("Free and Pro transcription limits remain distinct", () => {
  assert.match(planFixMigration, /v_monthly_seconds := 600/);
  assert.match(planFixMigration, /v_rate_limit_per_minute := 10/);
  assert.match(planFixMigration, /v_monthly_seconds := 18000/);
  assert.match(planFixMigration, /v_rate_limit_per_minute := 30/);
});

test("user command policies cache auth uid and trigger paths are fixed", () => {
  assert.match(hardeningMigration, /user_id = \(select auth\.uid\(\)\)/);
  assert.match(hardeningMigration, /alter function public\.fill_user_id\(\) set search_path = ''/);
  assert.match(hardeningMigration, /alter function public\.touch_updated_at\(\) set search_path = ''/);
});
