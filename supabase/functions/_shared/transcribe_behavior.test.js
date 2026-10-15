import assert from "node:assert/strict";
import test from "node:test";
import { loadEdgeHandler } from "./edge_test_support.js";
import { parsePcmWavDurationMs } from "./wav.ts";
import { ERROR_CODE_QUOTA_EXCEEDED, USAGE_PROVIDER_TENCENT_CLOUD } from "./contracts.ts";

const deviceId = "11111111-1111-4111-8111-111111111111";
function wav(durationMs) {
  const dataBytes = durationMs * 32;
  const bytes = new Uint8Array(44 + dataBytes), view = new DataView(bytes.buffer);
  const ascii = (off, value) => { for (let i = 0; i < value.length; i++) bytes[off + i] = value.charCodeAt(i); };
  ascii(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, dataBytes, true);
  return bytes;
}
function audioRequest({ durationMs = 1000, clientDurationMs = 1, device = deviceId, bytes = wav(durationMs) } = {}) {
  const body = new FormData();
  body.set("audio", new File([bytes], "voice.wav", { type: "audio/wav" }));
  body.set("duration_ms", String(clientDurationMs));
  if (device !== null) body.set("device_id", device);
  return new Request("https://local.invalid/transcribe", { method: "POST", headers: { Authorization: "Bearer runtime" }, body });
}

async function transcribing({ runtime = "runtime", target = { user_id: "owner", runtime_user_id: "runtime", status: "active", paired_at: "2026-01-01", id: deviceId }, providerError = null, maxMs = 60000, quotaError = null } = {}) {
  const rpcCalls = [], rows = [];
  let providerCalls = 0;
  const service = {
    async rpc(fn, params) {
      rpcCalls.push({ fn, params });
      if (fn === "resolve_transcribe_device") {
        const matched = target && target.id === params.p_device_id
          && target.runtime_user_id === params.p_runtime_user_id
          && target.status === "active" && Boolean(target.paired_at);
        return { data: matched ? { paired: true, user_id: target.user_id } : { paired: false }, error: null };
      }
      const error_code = params.p_audio_duration_ms > maxMs ? "audio_too_long" : quotaError;
      if (!error_code) rows.push({ user_id: params.p_user_id, request_id: params.p_request_id, status: "processing", audio_duration_ms: params.p_audio_duration_ms });
      return { data: { plan: "free", max_audio_ms: maxMs, error_code }, error: null };
    },
    from(table) {
      return {
        async insert(row) { rows.push(row); return { error: null }; },
        update(cols) {
          const filters = [];
          return { eq(k, v) { filters.push(row => row[k] === v); return this; }, in(k, v) { filters.push(row => v.includes(row[k])); return this; },
            then(resolve) { for (const row of rows) if (filters.every(f => f(row))) Object.assign(row, cols); resolve({ error: null }); }
          };
        }
      };
    }
  };
  const loaded = await loadEdgeHandler("../transcribe/index.ts", {
    createClient: (_url, key) => key === "service" ? service : { auth: { getClaims: async () => ({ data: { claims: { sub: runtime } }, error: null }) } },
    verifySupabaseJwt: async () => null, parsePcmWavDurationMs,
    ERROR_CODE_QUOTA_EXCEEDED, USAGE_PROVIDER_TENCENT_CLOUD,
    transcribeTencentWav: async () => { providerCalls++; if (providerError) throw providerError; return "测试文本"; }
  });
  return { ...loaded, rows, rpcCalls, providerCalls: () => providerCalls };
}

test("relay authorizes runtime device and bills owner by verified WAV duration", async () => {
  const { handler, flush, rpcCalls, rows } = await transcribing();
  const response = await handler(audioRequest({ durationMs: 1200, clientDurationMs: 1 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, "测试文本");
  assert.equal(rpcCalls[0].fn, "resolve_transcribe_device");
  const reserve = rpcCalls.find((call) => call.fn !== "resolve_transcribe_device");
  assert.equal(reserve.params.p_user_id, "owner");
  assert.equal(reserve.params.p_audio_duration_ms, 1200);
  await flush(); assert.equal(rows[0].status, "success"); assert.ok(rows[0].settled_at);
});

test("relay supports phone account without device delegation", async () => {
  const { handler, rpcCalls } = await transcribing({ runtime: "phone-account" });
  assert.equal((await handler(audioRequest({ device: null }))).status, 200);
  assert.equal(rpcCalls[0].params.p_user_id, "phone-account");
});

test("relay rejects foreign, revoked and unpaired devices before provider or quota", async () => {
  for (const override of [{ runtime_user_id: "foreign" }, { status: "revoked" }, { paired_at: null }]) {
    const { handler, rpcCalls, providerCalls } = await transcribing({ target: { id: deviceId, user_id: "owner", runtime_user_id: "runtime", status: "active", paired_at: "paired", ...override } });
    const response = await handler(audioRequest());
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "device_not_paired");
    assert.equal(rpcCalls.filter((call) => call.fn !== "resolve_transcribe_device").length, 0);
    assert.equal(providerCalls(), 0);
  }
});

test("relay cannot bypass free duration by declaring one millisecond", async () => {
  const { handler, providerCalls } = await transcribing({ maxMs: 15000 });
  const response = await handler(audioRequest({ durationMs: 16000, clientDurationMs: 1 }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "audio_too_long");
  assert.equal(providerCalls(), 0);
});

test("relay propagates quota failure and retains uncertain provider consumption", async () => {
  const limited = await transcribing({ quotaError: "quota_exceeded" });
  const response = await limited.handler(audioRequest());
  assert.equal(response.status, 429); assert.equal((await response.json()).code, "quota_exceeded");
  assert.equal(limited.providerCalls(), 0);
  const uncertain = await transcribing({ providerError: new Error("provider timeout") });
  assert.equal((await uncertain.handler(audioRequest())).status, 500);
  await uncertain.flush();
  assert.equal(uncertain.rows[0].status, "unknown");
  assert.equal(uncertain.rows[0].error_code, "provider_result_unknown");
});

test("trusted WAV parser rejects inconsistent headers and multiple data chunks", () => {
  assert.equal(parsePcmWavDurationMs(wav(1000)), 1000);
  for (const [offset, value, size] of [[4, 1, 4], [24, 48000, 4], [28, 1, 4], [32, 1, 2]]) {
    const bytes = wav(1000), view = new DataView(bytes.buffer);
    if (size === 4) view.setUint32(offset, value, true); else view.setUint16(offset, value, true);
    assert.equal(parsePcmWavDurationMs(bytes), null);
  }
  const original = wav(1000), duplicate = new Uint8Array(original.length + 10);
  duplicate.set(original); duplicate.set([100,97,116,97,2,0,0,0,0,0], original.length);
  new DataView(duplicate.buffer).setUint32(4, duplicate.length - 8, true);
  assert.equal(parsePcmWavDurationMs(duplicate), null);
});
