import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const authJs = await readFile(new URL("./auth.js", import.meta.url), "utf8");
const appJs = await readFile(new URL("./app.js", import.meta.url), "utf8");
const indexHtml = await readFile(new URL("./index.html", import.meta.url), "utf8");
const pairingJs = await readFile(new URL("./pairing.js", import.meta.url), "utf8");

test("auth overlay is disabled for local mode fallback", () => {
  assert.match(authJs, /const isCloudMode = config\.voicebridgeMode === "cloud"/);
  assert.match(authJs, /if \(!isCloudMode\) \{/);
  assert.match(authJs, /overlay\?\.classList\.add\("hidden"\)/);
});

test("cloud auth exposes logout and app starts from an existing session", () => {
  assert.match(indexHtml, /id="authLogoutButton"/);
  assert.match(authJs, /auth\.signOut\(\)/);
  assert.match(appJs, /void handleAuthState\(\{\s*detail:/);
});

test("cloud auth supports GitHub registration and login", () => {
  assert.match(indexHtml, /id="authGithubBtn"/);
  assert.match(indexHtml, /使用 GitHub 注册或登录/);
  assert.match(authJs, /signInWithOAuth\(\{/);
  assert.match(authJs, /provider:\s*"github"/);
  assert.match(authJs, /options:\s*\{\s*redirectTo\s*\}/);
});

test("GitHub users can set a desktop password from account settings", () => {
  assert.match(appJs, /usesGithubWithoutEmailPassword/);
  assert.match(appJs, /设置桌面登录密码/);
  assert.match(appJs, /auth\.updateUser\(\{ password: newPwd \}\)/);
});

test("phone can claim a QR pairing after authentication", () => {
  assert.match(indexHtml, /id="pairingOverlay"/);
  assert.match(indexHtml, /src="\/pairing\.js"/);
  assert.match(pairingJs, /action:\s*"claim"/);
  assert.match(pairingJs, /pairing_token/);
  assert.match(pairingJs, /Authorization:\s*`Bearer \$\{accessToken\}`/);
});

test("account drawer button and plan badge are shown for signed-in cloud users", () => {
  assert.match(appJs, /accountDrawerBtn\.disabled = !visible/);
  assert.match(appJs, /planBadge\?\.classList\.toggle\("hidden", !visible\)/);
});
