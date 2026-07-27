import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const authJs = await readFile(new URL("./auth.js", import.meta.url), "utf8");
const appJs = await readFile(new URL("./app.js", import.meta.url), "utf8");
const indexHtml = await readFile(new URL("./index.html", import.meta.url), "utf8");

test("auth overlay is disabled for local mode fallback", () => {
  assert.match(authJs, /const isCloudMode = config\.voicebridgeMode === "cloud"/);
  assert.match(authJs, /if \(!isCloudMode\) \{/);
  assert.match(authJs, /overlay\?\.classList\.add\("hidden"\)/);
});

test("cloud auth exposes account logout and app starts from an existing session", () => {
  assert.match(appJs, /window\.VoiceBridgeAuth\?\.signOut\(\)/);
  assert.match(authJs, /signOut:\s*async \(\) => supabase\?\.auth\.signOut\(\)/);
  assert.match(appJs, /void handleAuthState\(\{\s*detail:/);
});

test("account drawer button and plan badge are shown for signed-in cloud users", () => {
  assert.match(appJs, /accountDrawerBtn\.disabled = !visible/);
  assert.match(appJs, /planBadge\?\.classList\.toggle\("hidden", !visible\)/);
});
