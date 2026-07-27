import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const distRoot = new URL("../dist/", import.meta.url);

test("hosted PWA builds with cloud config and mobile entrypoint", async () => {
  const [html, config, worker, pairing] = await Promise.all([
    readFile(new URL("client/index.html", distRoot), "utf8"),
    readFile(new URL("client/config.js", distRoot), "utf8"),
    readFile(new URL("server/index.js", distRoot), "utf8"),
    readFile(new URL("client/pairing.js", distRoot), "utf8")
  ]);

  assert.match(html, /VoiceBridge/);
  assert.match(html, /manifest\.json/);
  assert.match(html, /id="authGithubBtn"/);
  assert.match(html, /创建账号/);
  assert.match(config, /voicebridgeMode:\s*"cloud"/);
  assert.match(config, /gqxxknusznbunkiznnal\.supabase\.co/);
  assert.match(worker, /env\.ASSETS\.fetch/);
  assert.match(pairing, /action:\s*"claim"/);
});

test("hosted build does not publish test files", async () => {
  await assert.rejects(access(new URL("client/cloudRealtime.test.js", distRoot)));
  await assert.rejects(access(new URL("client/shared/protocol.test.js", distRoot)));
});
