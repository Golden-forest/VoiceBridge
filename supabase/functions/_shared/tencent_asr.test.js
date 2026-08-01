import assert from "node:assert/strict";
import test from "node:test";

import {
  createTencentFlashRecognitionRequest,
  createTencentSentenceRecognitionRequest,
  removeFillerWords,
  transcribeTencentWav
} from "./tencent_asr.ts";

const config = {
  secretId: "secret-id",
  secretKey: "secret-key",
  appId: "123456",
  region: "ap-shanghai",
  engServiceType: "16k_zh"
};

test("FlashRecognition signs the dedicated raw-audio endpoint", async () => {
  const request = await createTencentFlashRecognitionRequest({
    audioBytes: new Uint8Array([1, 2, 3]),
    config,
    timestamp: 1_700_000_000
  });

  assert.match(request.url, /^https:\/\/asr\.cloud\.tencent\.com\/asr\/flash\/v1\/123456\?/);
  assert.match(request.url, /engine_type=16k_zh/);
  assert.equal(request.headers["Content-Type"], "application/octet-stream");
  assert.equal(request.headers["Content-Length"], "3");
  assert.ok(request.headers.Authorization);
});

test("Tencent ASR falls back to SentenceRecognition when FlashRecognition is unavailable", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ code: 4003, message: "service not enabled" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ Response: { Result: "fallback text" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const text = await transcribeTencentWav({
    audioBytes: new Uint8Array([1, 2, 3]),
    requestId: "request-1",
    config,
    fetchImpl
  });

  assert.equal(text, "fallback text");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /asr\.cloud\.tencent\.com\/asr\/flash/);
  assert.equal(calls[1].init.headers["X-TC-Action"], "SentenceRecognition");
});

test("FlashRecognition aligns Tencent filter params (filter_modal=1, filter_punc=0, filter_dirty=0, convert_num_mode=1)", async () => {
  const request = await createTencentFlashRecognitionRequest({
    audioBytes: new Uint8Array([1, 2, 3]),
    config,
    timestamp: 1_700_000_000
  });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("filter_modal"), "1", "filter_modal must be 1");
  assert.equal(url.searchParams.get("filter_punc"), "0", "filter_punc must be 0");
  assert.equal(url.searchParams.get("filter_dirty"), "0", "filter_dirty must be 0");
  assert.equal(url.searchParams.get("convert_num_mode"), "1", "convert_num_mode must be 1");
});

test("SentenceRecognition payload carries aligned Tencent filter params", async () => {
  const result = await createTencentSentenceRecognitionRequest({
    audioBase64: "AAAA",
    audioLength: 4,
    requestId: "req-1",
    config,
    timestamp: 1_700_000_000
  });
  assert.equal(result.payload.FilterDirty, 0);
  assert.equal(result.payload.FilterModal, 1);
  assert.equal(result.payload.FilterPunc, 0);
  assert.equal(result.payload.ConvertNumMode, 1);
});

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

test("FlashRecognition path applies removeFillerWords on its returned text", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        flash_result: [{ text: "嗯，你好嗯嗯嗯，世界" }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  const text = await transcribeTencentWav({
    audioBytes: new Uint8Array([1, 2, 3]),
    requestId: "req-flash",
    config,
    fetchImpl
  });
  assert.equal(text, "你好，世界");
});

test("SentenceRecognition fallback path applies removeFillerWords on its returned text", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ code: 4003, message: "service not enabled" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify({ Response: { Result: "嗯嗯嗯你好，世界嗯嗯嗯" } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const text = await transcribeTencentWav({
    audioBytes: new Uint8Array([1, 2, 3]),
    requestId: "req-sentence",
    config,
    fetchImpl
  });
  assert.equal(text, "你好，世界");
});
