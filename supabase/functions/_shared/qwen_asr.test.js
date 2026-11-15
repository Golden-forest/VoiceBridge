import assert from "node:assert/strict";
import test from "node:test";

import { transcribeQwenWav } from "./qwen_asr.ts";

const config = { apiKey: "sk-test" };

function qwenResponse(text) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text, role: "assistant" }, finish_reason: "stop" }],
    model: "qwen3-asr-flash"
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("sends base64 WAV data URI to the configured base URL with bearer auth", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return qwenResponse("你好，这是一段测试。");
  };

  const text = await transcribeQwenWav({
    audioBytes: new Uint8Array([1, 2, 3]),
    requestId: "request-1",
    config: { ...config, baseUrl: "https://example.invalid/compatible-mode/v1" },
    fetchImpl
  });

  assert.equal(text, "你好，这是一段测试。");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.invalid/compatible-mode/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "qwen3-asr-flash");
  const audio = body.messages[0].content.find((part) => part.type === "input_audio");
  assert.match(audio.input_audio.data, /^data:audio\/wav;base64,AQID$/);
  assert.equal(audio.input_audio.format, "wav");
});

test("defaults to the DashScope compatible-mode endpoint when no base URL is set", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return qwenResponse("默认地址测试。");
  };

  await transcribeQwenWav({ audioBytes: new Uint8Array([1]), requestId: "r", config, fetchImpl });

  assert.equal(calls[0], "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
});

test("applies filler-word cleanup to the transcript", async () => {
  const fetchImpl = async () => qwenResponse("嗯，你好。");
  const text = await transcribeQwenWav({ audioBytes: new Uint8Array([1]), requestId: "r", config, fetchImpl });
  assert.equal(text, "你好。");
});

test("surfaces the provider error message on HTTP failure", async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ error: { message: "Invalid API key" } }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
  await assert.rejects(
    () => transcribeQwenWav({ audioBytes: new Uint8Array([1]), requestId: "r", config, fetchImpl }),
    /Invalid API key/
  );
});

test("throws on empty transcript content", async () => {
  const fetchImpl = async () => qwenResponse("   ");
  await assert.rejects(
    () => transcribeQwenWav({ audioBytes: new Uint8Array([1]), requestId: "r", config, fetchImpl }),
    /empty text/i
  );
});

test("aborts the request when the provider exceeds the deadline", async () => {
  const fetchImpl = (url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });

  await assert.rejects(
    () => transcribeQwenWav({
      audioBytes: new Uint8Array([1]), requestId: "r", config, fetchImpl, timeoutMs: 30
    }),
    /timeout|abort/i
  );
});
