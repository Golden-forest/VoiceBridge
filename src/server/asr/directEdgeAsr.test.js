import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveAsrChannel,
  transcribeViaEdgeAsr
} from "./directEdgeAsr.js";

const BASE = "https://edge.test";
const ANON = "anon-key";
const TOKEN = "token-123";
const WAV = Buffer.from("RIFF-wav-bytes");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function okIssue({ requestId = "req-1", expiresAt = Math.floor(Date.now() / 1000) + 300 } = {}) {
  return jsonResponse({
    ok: true,
    request_id: requestId,
    url: "https://asr.tencentcloudapi.com/",
    headers: { Authorization: "TC3 signed" },
    expires_at: expiresAt
  });
}

function tencentOk(text = "嗯，你好世界") {
  return jsonResponse({ code: 0, flash_result: [{ text }] });
}

function createFetchSpy(responses) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const handler = responses.shift();
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return typeof handler === "function" ? handler(String(url), options) : handler;
  };
  return { fetchImpl, calls };
}

const baseCtx = () => ({
  wavBuffer: WAV,
  getAccessToken: async () => TOKEN,
  supabaseUrl: BASE,
  supabaseAnonKey: ANON
});

test("transcribeViaEdgeAsr happy path: issue -> tencent POST raw wav -> report success -> raw text", async () => {
  const { fetchImpl, calls } = createFetchSpy([
    okIssue(),
    tencentOk("你好，世界"),
    jsonResponse({ ok: true })
  ]);

  const text = await transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl });

  assert.equal(text, "你好，世界");

  const issue = calls[0];
  assert.equal(issue.url, `${BASE}/functions/v1/issue-asr-request`);
  assert.equal(issue.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(issue.options.headers.apikey, ANON);
  const issueBody = JSON.parse(issue.options.body);
  assert.equal(issueBody.audio_size_bytes, WAV.length);
  assert.ok(issueBody.duration_ms > 0);

  const tencent = calls[1];
  assert.equal(tencent.url, "https://asr.tencentcloudapi.com/");
  assert.deepEqual(tencent.options.headers, { Authorization: "TC3 signed" });
  assert.ok(Buffer.from(tencent.options.body).equals(WAV), "raw wav bytes posted to signed url");

  const report = calls[2];
  assert.equal(report.url, `${BASE}/functions/v1/report-asr-result`);
  assert.deepEqual(JSON.parse(report.options.body), {
    request_id: "req-1",
    status: "success",
    text_length: "你好，世界".length
  });
});

test("transcribeViaEdgeAsr joins flash_result segments", async () => {
  const { fetchImpl } = createFetchSpy([
    okIssue(),
    jsonResponse({ code: 0, flash_result: [{ text: "你好" }, { text: "世界" }] }),
    jsonResponse({ ok: true })
  ]);
  const text = await transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl });
  assert.equal(text, "你好世界");
});

test("transcribeViaEdgeAsr throws a public error when the token provider yields null", async () => {
  const { fetchImpl, calls } = createFetchSpy([]);
  await assert.rejects(
    transcribeViaEdgeAsr({ ...baseCtx(), getAccessToken: async () => null, fetchImpl }),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.ok(error.publicMessage);
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test("transcribeViaEdgeAsr throws when issue-asr-request fails, without touching tencent", async () => {
  const { fetchImpl, calls } = createFetchSpy([
    jsonResponse({ ok: false, code: "quota_exceeded", message: "本月云端语音识别额度已用完。" }, 429)
  ]);
  await assert.rejects(
    transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.match(error.publicMessage, /额度已用完/);
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test("transcribeViaEdgeAsr reports failed and throws when tencent returns an error code", async () => {
  const { fetchImpl, calls } = createFetchSpy([
    okIssue({ requestId: "req-f" }),
    jsonResponse({ code: 4001 }),
    jsonResponse({ ok: true })
  ]);
  await assert.rejects(
    transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl }),
    (error) => {
      assert.ok(error.publicMessage);
      return true;
    }
  );
  const report = calls[2];
  assert.equal(report.url, `${BASE}/functions/v1/report-asr-result`);
  assert.deepEqual(JSON.parse(report.options.body), {
    request_id: "req-f",
    status: "failed",
    error_code: "tencent_4001"
  });
});

test("transcribeViaEdgeAsr reports failed and throws when tencent text is empty", async () => {
  const { fetchImpl, calls } = createFetchSpy([
    okIssue({ requestId: "req-e" }),
    tencentOk("  "),
    jsonResponse({ ok: true })
  ]);
  await assert.rejects(transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl }));
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    request_id: "req-e",
    status: "failed",
    error_code: "empty_text"
  });
});

test("transcribeViaEdgeAsr tolerates report-asr-result failure", async () => {
  const { fetchImpl } = createFetchSpy([
    okIssue(),
    tencentOk("你好"),
    async () => {
      throw new Error("network down");
    }
  ]);
  const text = await transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl });
  assert.equal(text, "你好");
});

test("transcribeViaEdgeAsr reports invalid/stale signature payloads as failed", async () => {
  const stale = okIssue({ requestId: "req-s", expiresAt: Math.floor(Date.now() / 1000) - 10 });
  const { fetchImpl, calls } = createFetchSpy([stale, jsonResponse({ ok: true })]);
  await assert.rejects(transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl }));
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    request_id: "req-s",
    status: "failed",
    error_code: "stale_signature"
  });
});

// --- credential routing decision ---

test("resolveAsrChannel prefers local tencent credentials", () => {
  assert.equal(
    resolveAsrChannel(
      { tencentSecretId: "id", tencentSecretKey: "key" },
      { getAccessToken: async () => "t", supabaseUrl: BASE, supabaseAnonKey: ANON }
    ),
    "local"
  );
});

test("resolveAsrChannel falls back to the edge-signed path when local credentials are absent", () => {
  assert.equal(
    resolveAsrChannel(
      { tencentSecretId: "", tencentSecretKey: "" },
      { getAccessToken: async () => "t", supabaseUrl: BASE, supabaseAnonKey: ANON }
    ),
    "edge"
  );
});

test("resolveAsrChannel returns none without a token provider or supabase config", () => {
  assert.equal(resolveAsrChannel({ tencentSecretId: "", tencentSecretKey: "" }, null), "none");
  assert.equal(
    resolveAsrChannel({ tencentSecretId: "", tencentSecretKey: "" }, { getAccessToken: async () => "t" }),
    "none"
  );
});
