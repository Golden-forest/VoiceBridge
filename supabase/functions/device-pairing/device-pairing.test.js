import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../../migrations/0004_device_pairing.sql", import.meta.url), "utf8");

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
