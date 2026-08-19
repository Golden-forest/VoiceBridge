import test from "node:test";
import assert from "node:assert/strict";

import {
  transcribeCloudAudio,
  __clearAccessTokenCacheForTests,
  __waitForPendingAsrReportsForTests
} from "./cloudTranscribe.js";

const BASE = "https://project.supabase.co";
const TENCENT_URL = "https://asr.cloud.tencent.com/asr/flash/v1/123?signed=1";

test("transcribeCloudAudio falls back to the relay when direct ASR is unavailable", async () => {
  __clearAccessTokenCacheForTests();
  const calls = [];
  const supabase = createSupabaseClient({
    url: BASE,
    anonKey: "anon-key",
    accessToken: "access-token"
  });

  const result = await transcribeCloudAudio({
    supabase,
    audio: new Blob(["wav"], { type: "audio/wav" }),
    filename: "voicebridge.wav",
    durationMs: 1234,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("issue-asr-request")) {
        return jsonResponse(503, { ok: false, code: "direct_asr_unavailable", message: "直连识别暂不可用" });
      }
      return jsonResponse(200, { ok: true, request_id: "req-relay", text: "hello" });
    }
  });

  assert.deepEqual(result, { ok: true, request_id: "req-relay", text: "hello" });
  const relayCalls = calls.filter((c) => c.url.endsWith("/transcribe"));
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].url, `${BASE}/functions/v1/transcribe`);
  assert.equal(relayCalls[0].options.method, "POST");
  assert.equal(relayCalls[0].options.headers.apikey, "anon-key");
  assert.equal(relayCalls[0].options.headers.Authorization, "Bearer access-token");
  assert.equal(relayCalls[0].options.body.get("duration_ms"), "1234");
  assert.equal(relayCalls[0].options.body.get("audio").name, "voicebridge.wav");
});

test("transcribeCloudAudio direct path: issue → Tencent POST → success report, no relay call", async () => {
  __clearAccessTokenCacheForTests();
  const calls = [];
  const supabase = createSupabaseClient({
    url: BASE,
    anonKey: "anon-key",
    accessToken: "access-token"
  });

  const result = await transcribeCloudAudio({
    supabase,
    audio: new Blob(["wav-bytes"], { type: "audio/wav" }),
    durationMs: 1500,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("issue-asr-request")) {
        assert.deepEqual(JSON.parse(options.body), { duration_ms: 1500, audio_size_bytes: 9 });
        assert.equal(options.headers.Authorization, "Bearer access-token");
        return jsonResponse(200, {
          ok: true,
          request_id: "req-direct",
          url: TENCENT_URL,
          headers: { Authorization: "TC3-Signed", "Content-Type": "application/json" },
          expires_at: Math.floor(Date.now() / 1000) + 300
        });
      }
      if (url.startsWith("https://asr.cloud.tencent.com/")) {
        assert.equal(options.method, "POST");
        assert.equal(options.headers.Authorization, "TC3-Signed");
        assert.equal(options.body.size, 9);
        return jsonResponse(200, {
          code: 0,
          message: "success",
          flash_result: [{ text: " 你好，" }, { text: "嗯世界。" }]
        });
      }
      if (url.includes("report-asr-result")) {
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.request_id, "req-direct");
  // 语气词清理与 Edge 端 removeFillerWords 一致：“你好，嗯世界。” → “你好，世界。”
  assert.equal(result.text, "你好，世界。");

  // 成功路径的上报是 fire-and-forget：等它落地后再断言请求体。
  await __waitForPendingAsrReportsForTests();
  const report = calls.find((c) => c.url.includes("report-asr-result"));
  assert.ok(report, "report-asr-result must be called");
  assert.deepEqual(JSON.parse(report.options.body), {
    request_id: "req-direct",
    status: "success",
    text_length: "你好，世界。".length
  });
  assert.equal(report.options.keepalive, true);
  assert.equal(report.options.headers.Authorization, "Bearer access-token");

  assert.equal(calls.some((c) => c.url.endsWith("/transcribe")), false, "relay must not be used");
});

test("transcribeCloudAudio falls back to relay when Tencent returns a non-zero code, and reports failed", async () => {
  __clearAccessTokenCacheForTests();
  const calls = [];
  const supabase = createSupabaseClient({ url: BASE, anonKey: "anon-key", accessToken: "access-token" });

  const result = await transcribeCloudAudio({
    supabase,
    audio: new Blob(["wav"], { type: "audio/wav" }),
    durationMs: 1000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("issue-asr-request")) {
        return jsonResponse(200, {
          ok: true,
          request_id: "req-2",
          url: TENCENT_URL,
          headers: { Authorization: "TC3" },
          expires_at: Math.floor(Date.now() / 1000) + 300
        });
      }
      if (url.startsWith("https://asr.cloud.tencent.com/")) {
        return jsonResponse(200, { code: 4003, message: "flash not enabled" });
      }
      if (url.includes("report-asr-result")) {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, { ok: true, request_id: "req-relay", text: "relay text" });
    }
  });

  assert.equal(result.text, "relay text");
  const report = calls.find((c) => c.url.includes("report-asr-result"));
  assert.deepEqual(JSON.parse(report.options.body), {
    request_id: "req-2",
    status: "failed",
    error_code: "tencent_4003"
  });
  assert.ok(calls.some((c) => c.url.endsWith("/transcribe")), "relay fallback must run");
});

test("transcribeCloudAudio falls back to relay when Tencent fetch throws, and reports failed", async () => {
  __clearAccessTokenCacheForTests();
  const calls = [];
  const supabase = createSupabaseClient({ url: BASE, anonKey: "anon-key", accessToken: "access-token" });

  const result = await transcribeCloudAudio({
    supabase,
    audio: new Blob(["wav"], { type: "audio/wav" }),
    durationMs: 1000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("issue-asr-request")) {
        return jsonResponse(200, {
          ok: true,
          request_id: "req-3",
          url: TENCENT_URL,
          headers: { Authorization: "TC3" },
          expires_at: Math.floor(Date.now() / 1000) + 300
        });
      }
      if (url.startsWith("https://asr.cloud.tencent.com/")) {
        throw new Error("network down");
      }
      if (url.includes("report-asr-result")) {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, { ok: true, text: "relay ok" });
    }
  });

  assert.equal(result.text, "relay ok");
  const report = calls.find((c) => c.url.includes("report-asr-result"));
  assert.equal(JSON.parse(report.options.body).status, "failed");
});

test("transcribeCloudAudio falls back to relay on a stale expires_at", async () => {
  __clearAccessTokenCacheForTests();
  const calls = [];
  const supabase = createSupabaseClient({ url: BASE, anonKey: "anon-key", accessToken: "access-token" });

  const result = await transcribeCloudAudio({
    supabase,
    audio: new Blob(["wav"], { type: "audio/wav" }),
    durationMs: 1000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("issue-asr-request")) {
        return jsonResponse(200, {
          ok: true,
          request_id: "req-4",
          url: TENCENT_URL,
          headers: { Authorization: "TC3" },
          expires_at: Math.floor(Date.now() / 1000) - 10
        });
      }
      if (url.includes("report-asr-result")) {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, { ok: true, text: "relay ok" });
    }
  });

  assert.equal(result.text, "relay ok");
  assert.equal(calls.some((c) => c.url.startsWith("https://asr.cloud.tencent.com/")), false,
    "Tencent must not be called with a stale signature");
});

test("transcribeCloudAudio direct result survives a failed report-asr-result send", async () => {
  __clearAccessTokenCacheForTests();
  const supabase = createSupabaseClient({ url: BASE, anonKey: "anon-key", accessToken: "access-token" });

  const result = await transcribeCloudAudio({
    supabase,
    audio: new Blob(["wav"], { type: "audio/wav" }),
    durationMs: 1000,
    fetch: async (url) => {
      if (url.includes("issue-asr-request")) {
        return jsonResponse(200, {
          ok: true,
          request_id: "req-5",
          url: TENCENT_URL,
          headers: { Authorization: "TC3" },
          expires_at: Math.floor(Date.now() / 1000) + 300
        });
      }
      if (url.startsWith("https://asr.cloud.tencent.com/")) {
        return jsonResponse(200, { code: 0, flash_result: [{ text: "直接成功" }] });
      }
      if (url.includes("report-asr-result")) {
        throw new Error("report send failed");
      }
      throw new Error(`unexpected fetch: ${url}`);
    }
  });

  assert.equal(result.text, "直接成功");
  assert.equal(result.request_id, "req-5");
});

test("transcribeCloudAudio reports failed and falls back on an invalid issue payload with ok:true", async () => {
  __clearAccessTokenCacheForTests();
  const calls = [];
  const supabase = createSupabaseClient({ url: BASE, anonKey: "anon-key", accessToken: "access-token" });

  const result = await transcribeCloudAudio({
    supabase,
    audio: new Blob(["wav"], { type: "audio/wav" }),
    durationMs: 1000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("issue-asr-request")) {
        // ok:true 但缺少签名 URL：必须上报 failed 再回退，避免服务端预留悬挂。
        return jsonResponse(200, { ok: true, request_id: "req-invalid", headers: { Authorization: "TC3" } });
      }
      if (url.includes("report-asr-result")) {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, { ok: true, text: "relay ok" });
    }
  });

  assert.equal(result.text, "relay ok");
  const report = calls.find((c) => c.url.includes("report-asr-result"));
  assert.ok(report, "report-asr-result must be called for an invalid issue payload");
  assert.deepEqual(JSON.parse(report.options.body), {
    request_id: "req-invalid",
    status: "failed",
    error_code: "invalid_issue_response"
  });
  assert.equal(calls.some((c) => c.url.endsWith("/transcribe")), true, "relay fallback must run");
  assert.equal(calls.some((c) => c.url.startsWith("https://asr.cloud.tencent.com/")), false,
    "Tencent must not be called without a signed URL");
});

test("transcribeCloudAudio falls back to relay when the issue call itself throws", async () => {
  __clearAccessTokenCacheForTests();
  const supabase = createSupabaseClient({ url: BASE, anonKey: "anon-key", accessToken: "access-token" });

  const result = await transcribeCloudAudio({
    supabase,
    audio: new Blob(["wav"], { type: "audio/wav" }),
    durationMs: 1000,
    fetch: async (url) => {
      if (url.includes("issue-asr-request")) throw new Error("network down");
      return jsonResponse(200, { ok: true, text: "relay ok" });
    }
  });

  assert.equal(result.text, "relay ok");
});

test("transcribeCloudAudio throws the function error message for non-2xx JSON responses", async () => {
  __clearAccessTokenCacheForTests();
  const supabase = createSupabaseClient({
    url: BASE,
    anonKey: "anon-key",
    accessToken: "access-token"
  });

  await assert.rejects(
    () => transcribeCloudAudio({
      supabase,
      audio: new Blob(["wav"], { type: "audio/wav" }),
      fetch: async (url) => {
        if (url.includes("issue-asr-request")) {
          return jsonResponse(503, { ok: false, code: "direct_asr_unavailable", message: "直连识别暂不可用，请使用回退通道。" });
        }
        return jsonResponse(429, {
          ok: false,
          code: "quota_exceeded",
          message: "本月云端语音识别额度已用完。"
        });
      }
    }),
    /本月云端语音识别额度已用完/
  );
});

test("transcribeCloudAudio requires a signed-in Supabase session", async () => {
  __clearAccessTokenCacheForTests();
  const supabase = createSupabaseClient({
    url: BASE,
    anonKey: "anon-key",
    accessToken: ""
  });

  await assert.rejects(
    () => transcribeCloudAudio({
      supabase,
      audio: new Blob(["wav"], { type: "audio/wav" }),
      fetch: async () => {
        throw new Error("fetch should not be called");
      }
    }),
    /请先登录/
  );
});

function createSupabaseClient({ url, anonKey, accessToken }) {
  return {
    supabaseUrl: url,
    supabaseKey: anonKey,
    auth: {
      async getSession() {
        return {
          data: {
            session: accessToken ? { access_token: accessToken } : null
          },
          error: null
        };
      }
    }
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}
