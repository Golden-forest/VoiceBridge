import test from "node:test";
import assert from "node:assert/strict";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const originalExecFile = promisify(execFile);

// Stub state
let osascriptScript = "";
let osascriptResult = "";
let osascriptError = null;

const mockExecFile = async (cmd, args, opts) => {
  if (cmd === "osascript") {
    osascriptScript = args[args.length - 1];
    if (osascriptError) throw osascriptError;
    return { stdout: osascriptResult, stderr: "" };
  }
  return originalExecFile(cmd, args, opts);
};

import { listWindows } from "./windowManager.js";

test.beforeEach(() => {
  osascriptScript = "";
  osascriptResult = "";
  osascriptError = null;
});

test("listWindows returns empty array on non-macOS", async () => {
  const result = await listWindows({ execFileAsync: mockExecFile, platform: "linux" });
  assert.deepEqual(result, []);
});

test("listWindows parses AppleScript output into grouped structure", async () => {
  osascriptResult = `{
    "Chrome": ["GitHub - Pull Requests", "ChatGPT"],
    "VS Code": ["VoiceBridge - app.js"],
    "微信": ["文件传输助手"]
  }`;

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 3);
  assert.equal(result[0].appName, "Chrome");
  assert.equal(result[0].windows.length, 2);
  assert.equal(result[0].windows[0].title, "GitHub - Pull Requests");
  assert.equal(result[1].appName, "VS Code");
  assert.equal(result[2].appName, "微信");
});

test("listWindows filters out VoiceBridge itself", async () => {
  osascriptResult = `{
    "VoiceBridge": ["Terminal"],
    "Chrome": ["GitHub"]
  }`;

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 1);
  assert.equal(result[0].appName, "Chrome");
});

test("listWindows filters out apps with no windows", async () => {
  osascriptResult = `{
    "Chrome": [],
    "VS Code": ["project"]
  }`;

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 1);
  assert.equal(result[0].appName, "VS Code");
});

test("listWindows returns empty array on AppleScript error", async () => {
  osascriptError = new Error(" timed out.");
  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.deepEqual(result, []);
});

test("listWindows handles window titles with double quotes", async () => {
  osascriptResult = `{
    "Chrome": ["He said \\"hello\\""],
    "VS Code": ["project"]
  }`;

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 2);
  assert.equal(result[0].windows[0].title, `He said "hello"`);
});
