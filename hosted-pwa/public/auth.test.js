import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const authJs = await readFile(new URL("./auth.js", import.meta.url), "utf8");
const appJs = await readFile(new URL("./app.js", import.meta.url), "utf8");
const indexHtml = await readFile(new URL("./app.html", import.meta.url), "utf8");
const pairingJs = await readFile(new URL("./pairing.js", import.meta.url), "utf8");

test("auth overlay is disabled for local mode fallback", () => {
  assert.match(authJs, /const isCloudMode = config\.voicebridgeMode === "cloud"/);
  assert.match(authJs, /if \(!isCloudMode\) \{/);
  assert.match(authJs, /overlay\?\.classList\.add\("hidden"\)/);
});

test("cloud auth exposes account logout and app starts from an existing session", () => {
  assert.match(appJs, /window\.VoiceBridgeAuth\?\.signOut\(\)/);
  assert.match(authJs, /signOut:\s*async \(\) => supabase\?\.auth\.signOut\(\)/);
  assert.match(appJs, /void handleAuthState\(\{\s*detail:/);
  assert.match(authJs, /event !== "INITIAL_SESSION"/);
});

test("cloud auth loads the bundled Supabase SDK without a third-party runtime CDN", () => {
  assert.match(indexHtml, /<script src="\/vendor\/supabase\.js"><\/script>/);
  assert.doesNotMatch(indexHtml, /esm\.sh|@supabase\/supabase-js/);
  assert.match(authJs, /globalThis\.supabase\?\.createClient/);
});

test("cloud auth supports GitHub registration and login", () => {
  assert.match(indexHtml, /id="authGithubBtn"/);
  assert.match(indexHtml, /data-i18n="auth\.githubButton"/);
  assert.match(authJs, /signInWithOAuth\(\{/);
  assert.match(authJs, /provider:\s*"github"/);
  assert.match(authJs, /options:\s*\{\s*redirectTo\s*\}/);
  assert.match(authJs, /new URL\(window\.location\.href\)/);
  assert.match(authJs, /redirectTo\.pathname = "\/app"/);
});

test("password reset returns to the custom-domain app route", () => {
  assert.match(authJs, /resetPasswordForEmail\(email,\s*\{\s*redirectTo:\s*buildAppRedirectUrl\(\)\s*\}\)/);
});

test("GitHub users can set a desktop password from account settings", () => {
  assert.match(appJs, /usesGithubWithoutEmailPassword/);
  assert.match(appJs, /account\.setPassword/);
  assert.match(appJs, /auth\.updateUser\(\{ password: newPwd \}\)/);
});

test("phone can claim a QR pairing after authentication", () => {
  assert.match(indexHtml, /id="pairingOverlay"/);
  assert.match(indexHtml, /src="\/pairing\.js"/);
  assert.match(pairingJs, /action:\s*"claim"/);
  assert.match(pairingJs, /pairing_token/);
  assert.match(pairingJs, /Authorization:\s*`Bearer \$\{accessToken\}`/);
  assert.match(pairingJs, /url\.searchParams\.delete\("pairing_token"\)/);
  assert.match(pairingJs, /url\.searchParams\.delete\("device"\)/);
  assert.match(pairingJs, /`\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`/);
  assert.match(pairingJs, /voicebridge:pairing-success/);
  assert.match(appJs, /selectedCloudDeviceId = deviceId/);
});

test("account drawer button and plan badge are shown for signed-in cloud users", () => {
  assert.match(appJs, /accountDrawerBtn\.disabled = !visible/);
  assert.match(appJs, /planBadge\?\.classList\.toggle\("hidden", !visible\)/);
});

test("phone device refresh never updates ownership or pairing columns", () => {
  assert.match(appJs, /\.select\("id"\)/);
  assert.match(appJs, /existingDevice\s*\?\s*await sbAuth\.from\("devices"\)\.update/);
  const updateBranch = appJs.match(/existingDevice\s*\?\s*await sbAuth\.from\("devices"\)\.update\(\{([\s\S]*?)\}\)\.eq/)?.[1] || "";
  assert.doesNotMatch(updateBranch, /user_id|runtime_user_id|paired_at|device_type/);
});
