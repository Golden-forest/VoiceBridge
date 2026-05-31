import test from "node:test";
import assert from "node:assert/strict";

import { outputText } from "./outputText.js";

test("outputText writes clipboard before attempting paste", async () => {
  const calls = [];

  const result = await outputText("hello", {
    autoPaste: true,
    clipboardWriter: async (text) => calls.push(["clipboard", text]),
    pasteFn: async () => calls.push(["paste"])
  });

  assert.deepEqual(calls, [["clipboard", "hello"], ["paste"]]);
  assert.deepEqual(result, {
    copied: true,
    pasted: true,
    pasteError: null
  });
});

test("outputText can copy without auto paste", async () => {
  const calls = [];

  const result = await outputText("clipboard only", {
    autoPaste: false,
    clipboardWriter: async (text) => calls.push(["clipboard", text]),
    pasteFn: async () => calls.push(["paste"])
  });

  assert.deepEqual(calls, [["clipboard", "clipboard only"]]);
  assert.equal(result.copied, true);
  assert.equal(result.pasted, false);
});

test("outputText keeps clipboard success when paste fails", async () => {
  const result = await outputText("safe fallback", {
    autoPaste: true,
    clipboardWriter: async () => {},
    logger: { warn: () => {} },
    pasteFn: async () => {
      throw new Error("permission denied");
    }
  });

  assert.equal(result.copied, true);
  assert.equal(result.pasted, false);
  assert.match(result.pasteError, /permission denied/);
});

test("outputText activates target window before pasting", async () => {
  const calls = [];

  const result = await outputText("hello", {
    autoPaste: true,
    targetWindow: { appName: "Chrome", windowTitle: "GitHub" },
    activateWindowFn: async () => calls.push(["activate"]),
    clipboardWriter: async (text) => calls.push(["clipboard", text]),
    pasteFn: async () => calls.push(["paste"])
  });

  assert.deepEqual(calls, [["activate"], ["clipboard", "hello"], ["paste"]]);
  assert.deepEqual(result, { copied: true, pasted: true, pasteError: null });
});

test("outputText skips activation when targetWindow is null", async () => {
  const calls = [];

  const result = await outputText("hello", {
    autoPaste: true,
    targetWindow: null,
    activateWindowFn: async () => calls.push(["activate"]),
    clipboardWriter: async (text) => calls.push(["clipboard", text]),
    pasteFn: async () => calls.push(["paste"])
  });

  assert.deepEqual(calls, [["clipboard", "hello"], ["paste"]]);
});

test("outputText falls back to paste when activation fails", async () => {
  const calls = [];
  const warns = [];

  const result = await outputText("hello", {
    autoPaste: true,
    targetWindow: { appName: "Chrome", windowTitle: "GitHub" },
    activateWindowFn: async () => { throw new Error("not found"); },
    clipboardWriter: async (text) => calls.push(["clipboard", text]),
    pasteFn: async () => calls.push(["paste"]),
    logger: { warn: (msg) => warns.push(msg) }
  });

  assert.ok(calls[0][0] === "clipboard");
  assert.equal(result.copied, true);
  assert.equal(result.pasted, true);
});

test("outputText ignores targetWindow when autoPaste is false", async () => {
  const calls = [];

  const result = await outputText("hello", {
    autoPaste: false,
    targetWindow: { appName: "Chrome", windowTitle: "GitHub" },
    activateWindowFn: async () => calls.push(["activate"]),
    clipboardWriter: async (text) => calls.push(["clipboard", text]),
    pasteFn: async () => calls.push(["paste"])
  });

  assert.deepEqual(calls, [["clipboard", "hello"]]);
  assert.equal(result.pasted, false);
});
