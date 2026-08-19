import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { removeFillerWords, transcribeAudio } from "./transcriber.js";

async function writeReadyWav() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vb-transcribe-"));
  const buffer = Buffer.alloc(44 + 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + 4, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(4, 40);
  const filePath = path.join(dir, "phone.wav");
  await fs.writeFile(filePath, buffer);
  return { filePath, tmpDir: dir };
}

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

test("transcribeAudio transcribes phone wav via edge channel without ffmpeg", async () => {
  const { filePath, tmpDir } = await writeReadyWav();
  const json = (payload, ok = true) => ({ ok, json: async () => payload });
  const edgeAsr = {
    getAccessToken: async () => "token",
    supabaseUrl: "https://edge.test",
    supabaseAnonKey: "anon",
    fetchImpl: async (url) => {
      if (String(url).includes("issue-asr-request")) {
        return json({ ok: true, request_id: "r1", url: "https://tencent.test/flash", headers: {}, expires_at: Math.floor(Date.now() / 1000) + 60 });
      }
      if (String(url).includes("tencent.test")) {
        return json({ code: 0, flash_result: [{ text: "嗯，你好" }] });
      }
      return json({ ok: true });
    }
  };
  try {
    const text = await transcribeAudio(
      { filePath, tmpDir },
      { asrProvider: "tencent", tencentSecretId: "", tencentSecretKey: "" },
      edgeAsr
    );
    assert.equal(text, "你好");
    // 透传路径不得删除原始上传文件（清理职责在 upload 路由）。
    assert.equal(await fs.access(filePath).then(() => true, () => false), true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
