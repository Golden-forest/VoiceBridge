import assert from "node:assert/strict";
import test from "node:test";

import { ASR_ENGINES, getPreferredAsrEngine, setPreferredAsrEngine } from "./asrEngine.js";

function storage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

test("engine preference defaults to the server default and round-trips valid engines", () => {
  const store = storage();
  assert.equal(getPreferredAsrEngine(store), "");
  setPreferredAsrEngine(store, "qwen");
  assert.equal(getPreferredAsrEngine(store), "qwen");
  setPreferredAsrEngine(store, "tencent");
  assert.equal(getPreferredAsrEngine(store), "tencent");
  setPreferredAsrEngine(store, "");
  assert.equal(getPreferredAsrEngine(store), "");
});

test("engine preference ignores corrupted or unknown stored values", () => {
  const store = storage();
  store.setItem("vb:asr-engine", "baidu");
  assert.equal(getPreferredAsrEngine(store), "");
  store.setItem("vb:asr-engine", "[object Object]");
  assert.equal(getPreferredAsrEngine(store), "");
});

test("setPreferredAsrEngine rejects values outside the engine catalog", () => {
  const store = storage();
  assert.throws(() => setPreferredAsrEngine(store, "whisper"), /不支持的识别引擎/);
  assert.equal(getPreferredAsrEngine(store), "");
  assert.deepEqual(ASR_ENGINES.map((engine) => engine.value), ["", "tencent", "qwen"]);
});
