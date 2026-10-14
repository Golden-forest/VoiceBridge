import test from "node:test";
import assert from "node:assert/strict";
import { resolveAsrChannel, transcribeViaEdgeAsr } from "./edgeAsrRelay.js";

const context = {
  wavBuffer: Buffer.from("RIFF-test-wav"),
  getAccessToken: async () => "runtime-token",
  deviceId: "11111111-1111-4111-8111-111111111111",
  supabaseUrl: "https://relay.test/",
  supabaseAnonKey: "public-anon"
};
const response = (payload, status = 200) => ({ ok: status < 300, status, json: async () => payload });

test("LAN sends WAV and desktop identity only to the trusted relay", async () => {
  const calls = [];
  const text = await transcribeViaEdgeAsr({ ...context, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(url, "https://relay.test/functions/v1/transcribe");
    assert.equal(options.headers.Authorization, "Bearer runtime-token");
    assert.equal(options.headers.apikey, "public-anon");
    assert.equal(options.headers["Content-Type"], undefined);
    assert.equal(options.body.get("device_id"), context.deviceId);
    assert.deepEqual(Buffer.from(await options.body.get("audio").arrayBuffer()), context.wavBuffer);
    assert.equal(options.body.get("duration_ms"), null);
    return response({ ok: true, text: "可信识别" });
  }});
  assert.equal(text, "可信识别");
  assert.equal(calls.length, 1);
});

for (const status of [401, 403, 413, 429]) {
  test(`relay preserves ${status} rejection without retrying or client billing reports`, async () => {
    let calls = 0;
    await assert.rejects(transcribeViaEdgeAsr({ ...context, fetchImpl: async () => {
      calls++;
      return response({ ok: false, message: "可信拒绝" }, status);
    }}), (error) => error.statusCode === status && error.publicMessage === "可信拒绝");
    assert.equal(calls, 1);
  });
}

test("missing runtime session never sends an upload", async () => {
  await assert.rejects(transcribeViaEdgeAsr({ ...context, getAccessToken: async () => null,
    fetchImpl: () => assert.fail("must not upload")
  }), (error) => error.statusCode === 401);
});

test("relay rejects empty success text and bounds network timeout", async () => {
  await assert.rejects(transcribeViaEdgeAsr({ ...context,
    fetchImpl: async () => response({ ok: true, text: " " })
  }), /没有返回可用文字/);
  await assert.rejects(transcribeViaEdgeAsr({ ...context, timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  }), /超时/);
});

test("own Tencent credentials retain the local path; relay requires a paired desktop", () => {
  assert.equal(resolveAsrChannel({ tencentSecretId: "id", tencentSecretKey: "key" }, context), "local");
  assert.equal(resolveAsrChannel({}, context), "edge");
  assert.equal(resolveAsrChannel({}, { ...context, deviceId: null }), "none");
  assert.equal(resolveAsrChannel({}, null), "none");
});
