import test from "node:test";
import assert from "node:assert/strict";

import { outputText } from "./outputText.js";

test("outputText writes clipboard before attempting paste", async () => {
  const calls = [];

  const result = await outputText("hello", {
    autoPaste: true,
    pasteDelayMs: 0,
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
    pasteDelayMs: 0,
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
