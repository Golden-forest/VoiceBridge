import test from "node:test";
import assert from "node:assert/strict";

import {
  __waitForPendingAsrReportsForTests,
  createAsrPrefetchCache,
  resolveAsrChannel,
  transcribeViaEdgeAsr
} from "./directEdgeAsr.js";

const BASE = "https://edge.test";
const ANON = "anon-key";
const TOKEN = "token-123";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
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
  deviceId: DEVICE_ID,
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

  // 成功上报 fire-and-forget：主流程返回时上报可能尚未发出。
  await __waitForPendingAsrReportsForTests();

  const issue = calls[0];
  assert.equal(issue.url, `${BASE}/functions/v1/issue-asr-request`);
  assert.equal(issue.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(issue.options.headers.apikey, ANON);
  const issueBody = JSON.parse(issue.options.body);
  assert.equal(issueBody.audio_size_bytes, WAV.length);
  assert.ok(issueBody.duration_ms > 0);
  assert.equal(issueBody.device_id, DEVICE_ID);

  const tencent = calls[1];
  assert.equal(tencent.url, "https://asr.tencentcloudapi.com/");
  assert.deepEqual(tencent.options.headers, { Authorization: "TC3 signed" });
  assert.ok(Buffer.from(tencent.options.body).equals(WAV), "raw wav bytes posted to signed url");

  const report = calls[2];
  assert.equal(report.url, `${BASE}/functions/v1/report-asr-result`);
  assert.deepEqual(JSON.parse(report.options.body), {
    request_id: "req-1",
    status: "success",
    device_id: DEVICE_ID,
    text_length: "你好，世界".length,
    duration_ms: 1 // 13 字节 WAV ≈ 0.4ms，向上取整为结算下限 1ms
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

test("transcribeViaEdgeAsr retries one transient issue failure", async () => {
  const { fetchImpl, calls } = createFetchSpy([
    async () => { throw new Error("temporary network failure"); },
    okIssue(),
    tencentOk("你好"),
    jsonResponse({ ok: true })
  ]);
  const text = await transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl });
  assert.equal(text, "你好");
  await __waitForPendingAsrReportsForTests();
  assert.equal(calls.filter((call) => call.url.endsWith("/issue-asr-request")).length, 2);
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
    device_id: DEVICE_ID,
    error_code: "tencent_4001",
    duration_ms: 1
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
    device_id: DEVICE_ID,
    error_code: "empty_text",
    duration_ms: 1
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
  await __waitForPendingAsrReportsForTests();
});

test("transcribeViaEdgeAsr returns text without waiting for the success report", async () => {
  let releaseReport;
  const reportBlocked = new Promise((resolve) => { releaseReport = resolve; });
  const { fetchImpl, calls } = createFetchSpy([
    okIssue(),
    tencentOk("你好"),
    async () => {
      await reportBlocked;
      return jsonResponse({ ok: true });
    }
  ]);

  const text = await transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl });
  // 上报悬而未决时文字已返回，且上报请求已发起。
  assert.equal(text, "你好");
  assert.equal(calls.length, 3);

  releaseReport();
  await __waitForPendingAsrReportsForTests();
});

test("transcribeViaEdgeAsr reports invalid/stale signature payloads as failed", async () => {
  const stale = okIssue({ requestId: "req-s", expiresAt: Math.floor(Date.now() / 1000) - 10 });
  const { fetchImpl, calls } = createFetchSpy([stale, jsonResponse({ ok: true })]);
  await assert.rejects(transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl }));
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    request_id: "req-s",
    status: "failed",
    device_id: DEVICE_ID,
    error_code: "stale_signature",
    duration_ms: 1
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


// --- 录音期间签名预取（LAN 延迟优化） ---

test("transcribeViaEdgeAsr uses a fresh prefetched issue and skips the issue round-trip", async () => {
  const prefetched = {
    ok: true,
    request_id: "req-pre",
    url: "https://asr.tencentcloudapi.com/",
    headers: { Authorization: "TC3 pre-signed" },
    expires_at: Math.floor(Date.now() / 1000) + 300
  };
  // 没有实时签发请求：第一条 fetch 就是直传腾讯。
  const { fetchImpl, calls } = createFetchSpy([
    tencentOk("预取成功"),
    jsonResponse({ ok: true })
  ]);

  const text = await transcribeViaEdgeAsr({ ...baseCtx(), fetchImpl, prefetchedIssue: prefetched });

  assert.equal(text, "预取成功");
  await __waitForPendingAsrReportsForTests();
  assert.equal(calls[0].url, "https://asr.tencentcloudapi.com/", "no issue round-trip before tencent");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    request_id: "req-pre",
    status: "success",
    device_id: DEVICE_ID,
    text_length: "预取成功".length,
    duration_ms: 1
  });
});

test("transcribeViaEdgeAsr accepts a prefetched issue as a promise", async () => {
  const prefetched = {
    ok: true,
    request_id: "req-pre-p",
    url: "https://asr.tencentcloudapi.com/",
    headers: {},
    expires_at: Math.floor(Date.now() / 1000) + 300
  };
  const { fetchImpl, calls } = createFetchSpy([
    tencentOk("异步预取"),
    jsonResponse({ ok: true })
  ]);
  const text = await transcribeViaEdgeAsr({
    ...baseCtx(), fetchImpl, prefetchedIssue: Promise.resolve(prefetched)
  });
  assert.equal(text, "异步预取");
  assert.equal(calls.filter((call) => call.url.endsWith("/issue-asr-request")).length, 0);
});

test("transcribeViaEdgeAsr closes a stale prefetched reservation then issues fresh", async () => {
  const stalePrefetched = {
    ok: true,
    request_id: "req-stale",
    url: "https://asr.tencentcloudapi.com/",
    headers: {},
    expires_at: Math.floor(Date.now() / 1000) - 10
  };
  const { fetchImpl, calls } = createFetchSpy([
    // 顺序：stale 关闭上报 -> 实时签发 -> 腾讯 -> 成功上报
    jsonResponse({ ok: true }),
    okIssue({ requestId: "req-fresh" }),
    tencentOk("过期回退"),
    jsonResponse({ ok: true })
  ]);

  const text = await transcribeViaEdgeAsr({
    ...baseCtx(), fetchImpl, prefetchedIssue: stalePrefetched
  });

  assert.equal(text, "过期回退", "stale prefetch falls back to a fresh issue, not failure");
  await __waitForPendingAsrReportsForTests();
  const staleReport = JSON.parse(calls[0].options.body);
  assert.equal(staleReport.request_id, "req-stale");
  assert.equal(staleReport.status, "failed");
  assert.equal(staleReport.error_code, "stale_signature");
  assert.equal(staleReport.duration_ms, 1, "stale settle carries actual duration");
});

test("transcribeViaEdgeAsr ignores a rejected prefetch promise and issues fresh", async () => {
  const { fetchImpl, calls } = createFetchSpy([
    okIssue({ requestId: "req-fresh2" }),
    tencentOk("失败回退"),
    jsonResponse({ ok: true })
  ]);
  const text = await transcribeViaEdgeAsr({
    ...baseCtx(), fetchImpl, prefetchedIssue: Promise.reject(new Error("prefetch blew up"))
  });
  assert.equal(text, "失败回退");
  assert.equal(calls.filter((call) => call.url.endsWith("/issue-asr-request")).length, 1);
});

// --- createAsrPrefetchCache ---

function fakeTimers() {
  const timers = [];
  return {
    setTimeoutImpl: (fn, ms) => { const id = { fn, ms }; timers.push(id); return id; },
    clearTimeoutImpl: (id) => { const i = timers.indexOf(id); if (i !== -1) timers.splice(i, 1); },
    run: () => { const t = timers.shift(); if (t) t.fn(); },
    pending: () => timers.length
  };
}

test("prefetch cache: begin issues with clamped max duration and consume is one-shot", async () => {
  const { fetchImpl, calls } = createFetchSpy([
    okIssue({ requestId: "req-cache" })
  ]);
  const cache = createAsrPrefetchCache({ ...baseCtx(), fetchImpl });

  const pending = cache.begin(120_000); // clamp 到 60s
  assert.ok(pending);
  const issue = await pending;
  assert.equal(issue.request_id, "req-cache");
  const issueBody = JSON.parse(calls[0].options.body);
  assert.equal(issueBody.duration_ms, 60_000);
  assert.equal(issueBody.audio_size_bytes, 60_000 * 32);

  assert.equal(await cache.consume(), issue, "consume returns the resolved issue");
  assert.equal(cache.consume(), null, "second consume yields null (serial fallback)");
});

test("prefetch cache: begin dedupes concurrent callers", async () => {
  const { fetchImpl, calls } = createFetchSpy([okIssue({ requestId: "req-dedupe" })]);
  const cache = createAsrPrefetchCache({ ...baseCtx(), fetchImpl });
  const first = cache.begin(30_000);
  const second = cache.begin(30_000);
  assert.equal(first, second, "concurrent begin reuses the same reservation");
  await first;
  assert.equal(calls.filter((call) => call.url.endsWith("/issue-asr-request")).length, 1);
});

test("prefetch cache: failed begin clears the slot for a retry", async () => {
  const { fetchImpl, calls } = createFetchSpy([
    jsonResponse({ ok: false }, 500),
    okIssue({ requestId: "req-retry" })
  ]);
  const cache = createAsrPrefetchCache({ ...baseCtx(), fetchImpl });
  assert.equal(await cache.begin(30_000), null, "failed prefetch resolves null");
  const retried = await cache.begin(30_000);
  assert.equal(retried?.request_id, "req-retry", "next begin starts a fresh reservation");
});

test("prefetch cache: watchdog closes an unconsumed reservation after expiry", async () => {
  let clock = Date.now();
  const timers = fakeTimers();
  const { fetchImpl, calls } = createFetchSpy([
    okIssue({ requestId: "req-watch", expiresAt: Math.floor(clock / 1000) + 60 }),
    jsonResponse({ ok: true })
  ]);
  const cache = createAsrPrefetchCache({
    ...baseCtx(),
    fetchImpl,
    now: () => clock,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl
  });

  await cache.begin(60_000);
  assert.equal(timers.pending(), 1, "watchdog armed when the signature arrives");

  // 无人消费：看门狗触发后关闭预留。
  timers.run();
  await new Promise((resolve) => setImmediate(resolve));
  const report = calls[1];
  assert.equal(report.url, `${BASE}/functions/v1/report-asr-result`);
  assert.deepEqual(JSON.parse(report.options.body), {
    request_id: "req-watch",
    status: "failed",
    device_id: DEVICE_ID,
    error_code: "stale_signature"
  });
  assert.equal(cache.consume(), null, "slot cleared after watchdog");
});

test("prefetch cache: consume cancels the watchdog; close cancels and settles reservations", async () => {
  let clock = Date.now();
  const timers = fakeTimers();
  const { fetchImpl, calls } = createFetchSpy([
    okIssue({ requestId: "req-first", expiresAt: Math.floor(clock / 1000) + 60 }),
    okIssue({ requestId: "req-close", expiresAt: Math.floor(clock / 1000) + 60 }),
    jsonResponse({ ok: true })
  ]);
  const cache = createAsrPrefetchCache({
    ...baseCtx(),
    fetchImpl,
    now: () => clock,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl
  });

  await cache.begin(60_000);
  cache.consume();
  assert.equal(timers.pending(), 0, "consume cancels the watchdog");
  timers.run(); // 无事发生：看门狗已取消
  assert.equal(calls.filter((call) => call.url.endsWith("/report-asr-result")).length, 0);

  // 新的一轮预取未消费就 close（网络切换重建服务）。
  const second = await cache.begin(60_000);
  assert.equal(second?.request_id, "req-close");
  await cache.close();
  assert.equal(timers.pending(), 0, "close cancels the watchdog");
  await new Promise((resolve) => setImmediate(resolve)); // close 的上报是脱离链，flush 微任务
  const report = calls.find((call) => call.url.endsWith("/report-asr-result"));
  assert.equal(JSON.parse(report.options.body).error_code, "canceled");
  assert.equal(JSON.parse(report.options.body).request_id, "req-close", "unconsumed reservation closed");
});
