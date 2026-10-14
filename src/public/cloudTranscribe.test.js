import assert from "node:assert/strict";
import test from "node:test";
import { transcribeCloudAudio, setAsrTimingListener } from "./cloudTranscribe.js";

const BASE = "https://example.invalid";
const audio = new Blob(["wav"], { type: "audio/wav" });
function client(readSession = () => ({ access_token: "token-A", user: { id: "A" } })) {
  return { supabaseUrl: BASE, supabaseKey: "anon", auth: { async getSession() { return { data: { session: readSession() } }; } } };
}
function response(payload = { ok: true, text: " transcript " }, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("relay sends actual audio, filename and duration without issuing a direct signature", async () => {
  const calls = [];
  const result = await transcribeCloudAudio({ supabase: client(), audio, filename: "clip.wav", durationMs: 1234.6,
    allowDirectAsr: true, prefetchedIssue: Promise.resolve({ request_id: "old-direct" }),
    fetch: async (url, options) => { calls.push({ url, options }); return response(); } });
  assert.equal(result.text, "transcript");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/functions/v1/transcribe`);
  assert.equal(calls[0].options.headers.Authorization, "Bearer token-A");
  assert.equal(calls[0].options.body.get("audio").name, "clip.wav");
  assert.equal(calls[0].options.body.get("duration_ms"), "1235");
});

test("each request uses the current account and independently refreshed token", async () => {
  let session = { access_token: "token-A", user: { id: "A" } };
  const supabase = client(() => session);
  const tokens = [];
  const fetch = async (_url, options) => { tokens.push(options.headers.Authorization); return response(); };
  await transcribeCloudAudio({ supabase, audio, fetch });
  session = { access_token: "token-B", user: { id: "B" } };
  await transcribeCloudAudio({ supabase, audio, fetch });
  session = { access_token: "token-B-refreshed", user: { id: "B" } };
  await transcribeCloudAudio({ supabase, audio, fetch });
  assert.deepEqual(tokens, ["Bearer token-A", "Bearer token-B", "Bearer token-B-refreshed"]);
});

test("a changed account or logout prevents uploading the old recording", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return response(); };
  await assert.rejects(transcribeCloudAudio({ supabase: client(() => ({ access_token: "token-B", user: { id: "B" } })), expectedUserId: "A", audio, fetch }), { name: "AbortError" });
  await assert.rejects(transcribeCloudAudio({ supabase: client(() => null), audio, fetch }), /请先登录/);
  assert.equal(calls, 0);
});

test("cancel during asynchronous session lookup prevents network activity", async () => {
  let resolveSession;
  const controller = new AbortController();
  let calls = 0;
  const supabase = { ...client(), auth: { getSession: () => new Promise((resolve) => { resolveSession = resolve; }) } };
  const pending = transcribeCloudAudio({ supabase, audio, signal: controller.signal, fetch: async () => { calls++; return response(); } });
  controller.abort();
  resolveSession({ data: { session: { access_token: "A", user: { id: "A" } } } });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 0);
});

test("cancel propagates to an in-flight relay and keeps cancellation distinct from timeout", async () => {
  const controller = new AbortController();
  let relaySignal;
  const pending = transcribeCloudAudio({ supabase: client(), audio, signal: controller.signal,
    fetch: async (_url, options) => { relaySignal = options.signal; return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })); } });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(relaySignal.aborted, true);
});

test("relay API failure, malformed JSON, and empty transcript never report success", async () => {
  await assert.rejects(transcribeCloudAudio({ supabase: client(), audio, fetch: async () => response({ ok: false, error: "quota exhausted" }, 429) }), /quota exhausted/);
  await assert.rejects(transcribeCloudAudio({ supabase: client(), audio, fetch: async () => new Response("not JSON") }), /识别失败/);
  await assert.rejects(transcribeCloudAudio({ supabase: client(), audio, fetch: async () => response({ ok: true, text: " " }) }), /没有返回可用文字/);
});

test("observability errors cannot discard a valid transcript", async () => {
  setAsrTimingListener(() => { throw new Error("observer failed"); });
  try { assert.equal((await transcribeCloudAudio({ supabase: client(), audio, fetch: async () => response() })).text, "transcript"); }
  finally { setAsrTimingListener(null); }
});
