import test from "node:test";
import assert from "node:assert/strict";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const originalExecFile = promisify(execFile);

// Stub state
let osascriptScript = "";
let osascriptStderr = "";
let osascriptError = null;

const mockExecFile = async (cmd, args, opts) => {
  if (cmd === "osascript") {
    osascriptScript = args[args.length - 1];
    if (osascriptError) throw osascriptError;
    return { stdout: "", stderr: osascriptStderr };
  }
  return originalExecFile(cmd, args, opts);
};

import { listWindows, activateWindow } from "./windowManager.js";

test.beforeEach(() => {
  osascriptScript = "";
  osascriptStderr = "";
  osascriptError = null;
});

test("listWindows returns empty array on non-macOS", async () => {
  const result = await listWindows({ execFileAsync: mockExecFile, platform: "linux" });
  assert.deepEqual(result, []);
});

test("listWindows parses tab-delimited stderr into grouped structure", async () => {
  // osascript log output goes to stderr, format: "appName\twindowTitle"
  osascriptStderr = [
    "Chrome\tGitHub - Pull Requests",
    "Chrome\tChatGPT",
    "VS Code\tVoiceBridge - app.js",
    "微信\t文件传输助手"
  ].join("\n");

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 3);
  assert.equal(result[0].appName, "Chrome");
  assert.equal(result[0].windows.length, 2);
  assert.equal(result[0].windows[0].title, "GitHub - Pull Requests");
  assert.equal(result[1].appName, "VS Code");
  assert.equal(result[2].appName, "微信");
});

test("listWindows filters out VoiceBridge itself", async () => {
  osascriptStderr = [
    "VoiceBridge\tTerminal",
    "Chrome\tGitHub"
  ].join("\n");

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 1);
  assert.equal(result[0].appName, "Chrome");
});

test("listWindows ignores lines without tabs", async () => {
  osascriptStderr = "some debug output without tabs\nChrome\tGitHub";

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 1);
  assert.equal(result[0].appName, "Chrome");
});

test("listWindows returns empty array on AppleScript error", async () => {
  osascriptError = new Error(" timed out.");
  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.deepEqual(result, []);
});

test("listWindows handles window titles with special characters", async () => {
  osascriptStderr = [
    'Chrome\tHe said "hello"',
    "VS Code\tproject"
  ].join("\n");

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 2);
  assert.equal(result[0].windows[0].title, 'He said "hello"');
});

test("activateWindow returns success false on non-macOS", async () => {
  const result = await activateWindow("Chrome", "GitHub", { execFileAsync: mockExecFile, platform: "linux" });
  assert.equal(result.success, false);
  assert.match(result.error, /macOS/);
});

test("activateWindow calls osascript with correct app and window", async () => {
  const result = await activateWindow("Chrome", "GitHub", { execFileAsync: mockExecFile });
  assert.equal(result.success, true);
  assert.ok(osascriptScript.includes("Chrome"));
  assert.ok(osascriptScript.includes("GitHub"));
});

test("activateWindow returns failure on error", async () => {
  osascriptError = new Error("window not found");
  const warns = [];
  const result = await activateWindow("NoApp", "NoWindow", {
    execFileAsync: mockExecFile,
    logger: { warn: (msg) => warns.push(msg) }
  });
  assert.equal(result.success, false);
  assert.ok(warns.length > 0);
});
