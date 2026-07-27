import assert from "node:assert/strict";
import test from "node:test";

import {
  createTencentFlashRecognitionRequest,
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
