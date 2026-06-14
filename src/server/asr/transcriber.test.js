import test from "node:test";
import assert from "node:assert/strict";

import { removeFillerWords, cleanAsrPunctuation, transcribeAudio } from "./transcriber.js";

// --- removeFillerWords tests ---

test("removes a single filler word", () => {
  assert.equal(removeFillerWords("嗯"), "");
});

test("removes filler with trailing punctuation", () => {
  assert.equal(removeFillerWords("嗯，"), "");
});

test("removes filler between words", () => {
  assert.equal(removeFillerWords("我说嗯然后"), "我说然后");
});

test("removes multiple consecutive fillers", () => {
  assert.equal(removeFillerWords("嗯呃啊"), "");
});

test("preserves normal text without fillers", () => {
  assert.equal(removeFillerWords("你好世界"), "你好世界");
});

test("returns empty string for null/undefined input", () => {
  assert.equal(removeFillerWords(null), null);
  assert.equal(removeFillerWords(undefined), undefined);
});

test("returns empty string for empty input", () => {
  assert.equal(removeFillerWords(""), "");
});

test("removes filler at start of text", () => {
  assert.equal(removeFillerWords("嗯你好"), "你好");
});

test("removes filler at end of text", () => {
  assert.equal(removeFillerWords("你好嗯"), "你好");
});

test("removes filler with comma between words", () => {
  assert.equal(removeFillerWords("你好，嗯，再见"), "你好，再见");
});

test("does not filter multi-word phrases like 然后 or 就是", () => {
  assert.equal(removeFillerWords("然后就是那个"), "然后就是那个");
});

test("removes 啊 even when part of meaningful ending", () => {
  assert.equal(removeFillerWords("对啊"), "对");
  assert.equal(removeFillerWords("好啊"), "好");
});

test("removes various filler characters", () => {
  assert.equal(removeFillerWords("呃"), "");
  assert.equal(removeFillerWords("哦"), "");
  assert.equal(removeFillerWords("唔"), "");
  assert.equal(removeFillerWords("噢"), "");
  assert.equal(removeFillerWords("欸"), "");
  assert.equal(removeFillerWords("诶"), "");
  assert.equal(removeFillerWords("哼"), "");
});

// --- processing order test (removeFillerWords then cleanAsrPunctuation) ---

test("removeFillerWords runs before cleanAsrPunctuation so 啊 is stripped before closing-particle check", () => {
  // Input simulates ASR thinking pause: "我说了一些东西啊。然后继续做"
  // After removeFillerWords: "我说了一些东西然后继续做"
  //   (啊。 is consumed as filler + trailing punctuation)
  // After cleanAsrPunctuation: no change (no punctuation left to clean)
  const input = "我说了一些东西啊。然后继续做";
  const afterFiller = removeFillerWords(input);
  assert.equal(afterFiller, "我说了一些东西然后继续做");
  const afterPunct = cleanAsrPunctuation(afterFiller);
  assert.equal(afterPunct, "我说了一些东西然后继续做");
});

// --- transcribeAudio tests ---

test("transcribeAudio returns a user-facing error when API key is missing", async () => {
  await assert.rejects(
    () =>
      transcribeAudio(
        { filePath: "/tmp/missing.webm", tmpDir: "/tmp" },
        { asrProvider: "tencent", tencentSecretId: "", tencentSecretKey: "" }
      ),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.match(error.publicMessage, /腾讯云/);
      return true;
    }
  );
});
