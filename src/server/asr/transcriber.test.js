import test from "node:test";
import assert from "node:assert/strict";

import { removeFillerWords, transcribeAudio } from "./transcriber.js";

// --- removeFillerWords ---

test("removes single filler characters", () => {
  assert.equal(removeFillerWords("嗯"), "");
  assert.equal(removeFillerWords("呃"), "");
  assert.equal(removeFillerWords("嗯，你好"), "，你好");
});

test("removes filler between words", () => {
  assert.equal(removeFillerWords("我说嗯然后"), "我说然后");
});

test("removes filler at start and end", () => {
  assert.equal(removeFillerWords("嗯你好"), "你好");
  assert.equal(removeFillerWords("你好嗯"), "你好");
});

test("preserves normal words (no over-filtering)", () => {
  // 不再删除多字词组（其实/反正/大概等是正常用词）
  assert.equal(removeFillerWords("其实我想说一下"), "其实我想说一下");
  assert.equal(removeFillerWords("我们在那个地方等你"), "我们在那个地方等你");
});

test("preserves ASR punctuation as-is", () => {
  // 信任 ASR 标点，不做增删
  assert.equal(removeFillerWords("你好。世界。"), "你好。世界。");
  assert.equal(removeFillerWords("是吗？是的。"), "是吗？是的。");
});

test("returns null/undefined for null/undefined input", () => {
  assert.equal(removeFillerWords(null), null);
  assert.equal(removeFillerWords(undefined), undefined);
  assert.equal(removeFillerWords(""), "");
});

// --- transcribeAudio error handling ---

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
