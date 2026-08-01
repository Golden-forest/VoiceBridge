import test from "node:test";
import assert from "node:assert/strict";

import { removeFillerWords, transcribeAudio } from "./transcriber.js";

// --- removeFillerWords (canonical fixtures, shared with Edge Function) ---

const FILLER_FIXTURES = [
  ["嗯，你好", "你好"],
  ["你好嗯嗯嗯，世界", "你好，世界"],
  ["嗯嗯嗯你好", "你好"],
  ["你好，嗯嗯嗯，世界", "你好，世界"],
  ["哼唱", "哼唱"],
  ["啧啧称奇", "啧啧称奇"],
  ["", ""],
  ["你好世界", "你好世界"],
  ["嗯嗯嗯", ""],
  ["你好，世界嗯嗯嗯", "你好，世界"]
];

for (const [input, expected] of FILLER_FIXTURES) {
  test(`removeFillerWords(${JSON.stringify(input)}) => ${JSON.stringify(expected)}`, () => {
    assert.equal(removeFillerWords(input), expected);
  });
}

test("returns null/undefined for null/undefined input", () => {
  assert.equal(removeFillerWords(null), null);
  assert.equal(removeFillerWords(undefined), undefined);
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
