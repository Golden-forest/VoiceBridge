import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
const migration = await readFile(
  new URL("../../migrations/0007_reserve_and_get_plan.sql", import.meta.url),
  "utf8"
);

test("transcribe reserves usage and resolves plan in one RPC", () => {
  assert.match(source, /\.rpc\("reserve_and_get_plan"/);
  assert.doesNotMatch(source, /\.from\("subscriptions"\)/);
  assert.match(source, /PLAN_CACHE_TTL_MS = 60_000/);
});

test("reserve_and_get_plan is service-role only and indexed for its filters", () => {
  assert.match(migration, /security invoker/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /subscriptions_user_updated_at_idx/);
  assert.match(migration, /usage_events_user_created_at_idx/);
  assert.match(migration, /to service_role/);
  assert.match(migration, /from public, anon, authenticated/);
});
