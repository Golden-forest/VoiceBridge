import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileAuthStorage } from "./authStorage.js";

test("file auth storage persists and removes Supabase session values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "voicebridge-auth-"));
  const filePath = path.join(dir, "auth.json");
  const storage = createFileAuthStorage(filePath);

  assert.equal(await storage.getItem("session"), null);
  await storage.setItem("session", "secret-session-value");
  assert.equal(await storage.getItem("session"), "secret-session-value");
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  await storage.removeItem("session");
  assert.equal(await storage.getItem("session"), null);
  assert.doesNotMatch(await readFile(filePath, "utf8"), /secret-session-value/);
});
