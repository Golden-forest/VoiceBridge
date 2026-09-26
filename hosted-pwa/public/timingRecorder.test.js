import test from "node:test";
import assert from "node:assert/strict";

import { createRecordingTimingStore } from "./timingRecorder.js";

test("timing store returns null before any note", () => {
  const store = createRecordingTimingStore();
  assert.equal(store.get(), null);
});

test("timing store merges partial notes and stamps time", () => {
  const store = createRecordingTimingStore();
  store.note({ encodeMs: 120 });
  store.note({ channel: "direct", asrMs: 800 });
  const snapshot = store.get();
  assert.equal(snapshot.encodeMs, 120, "earlier fields survive later notes");
  assert.equal(snapshot.channel, "direct");
  assert.equal(snapshot.asrMs, 800);
  assert.ok(Number.isFinite(snapshot.at), "timestamp stamped automatically");
});

test("timing store ignores malformed input", () => {
  const store = createRecordingTimingStore();
  store.note(null);
  store.note("junk");
  assert.equal(store.get(), null);
});

test("timing store reset starts a fresh recording snapshot", () => {
  const store = createRecordingTimingStore();
  store.note({ lan: true, totalMs: 800 });
  store.reset();
  assert.equal(store.get(), null);
  store.note({ channel: "direct", totalMs: 300 });
  assert.deepEqual(
    { channel: store.get().channel, totalMs: store.get().totalMs, lan: store.get().lan },
    { channel: "direct", totalMs: 300, lan: undefined }
  );
});
