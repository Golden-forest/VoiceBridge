import assert from "node:assert/strict";
import test from "node:test";

import {
  createIssueAsrHandler,
  createReportAsrHandler,
  DIRECT_ASR_SIGNATURE_TTL_SECONDS
} from "./direct_asr.ts";

// === 测试脚手架：内存版 service client，模拟 usage_events 与 reserve_and_get_plan ===

function createMockServiceClient({ reservation } = {}) {
  const rpcCalls = [];
  const updates = [];
  const inserts = [];
  const rows = new Map(); // request_id -> row
  const client = {
    rpcCalls,
    updates,
    inserts,
    async rpc(fn, params) {
      rpcCalls.push({ fn, params });
      if (fn !== "reserve_and_get_plan") {
        return { data: null, error: new Error("unknown rpc") };
      }
      const errorCode = reservation?.errorCode ?? null;
      if (!errorCode) {
        rows.set(params.p_request_id, {
          user_id: params.p_user_id,
          request_id: params.p_request_id,
          provider: params.p_provider,
          mode: params.p_mode,
          audio_duration_ms: params.p_audio_duration_ms,
          audio_size_bytes: params.p_audio_size_bytes,
          status: "reserved",
          error_code: null
        });
      }
      return {
        data: { plan: reservation?.plan ?? "free", max_audio_ms: 60_000, error_code: errorCode },
        error: null
      };
    },
    from(table) {
      if (table !== "usage_events") throw new Error("unexpected table");
      return {
        insert(row) {
          inserts.push(row);
          return { then(resolve) { resolve({ error: null }); } };
        },
        update(cols) {
          const pending = { cols, filters: [] };
          return {
            eq(col, value) {
              pending.filters.push([col, value]);
              return this;
            },
            then(resolve) {
              updates.push(pending);
              for (const row of rows.values()) {
                const matches = pending.filters.every(([c, v]) => row[c] === v);
                if (matches) Object.assign(row, pending.cols);
              }
              resolve({ error: null });
            }
          };
        }
      };
    },
    rows
  };
  return client;
}

const TENCENT_ENV = {
  secretId: "secret-id",
  secretKey: "secret-key",
  appId: "123456",
  region: "ap-shanghai",
  engServiceType: "16k_zh"
};

const BASE_ENV = {
  supabaseUrl: "https://stub.supabase.co",
  supabaseAnonKey: "anon",
  supabaseServiceRoleKey: "service-role",
  jwksJson: null,
  tencent: TENCENT_ENV
};

function authedRequest(body) {
  return new Request("https://edge/functions/v1/issue-asr-request", {
    method: "POST",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function buildIssueHandler(client, { userId = "user-1", env = BASE_ENV } = {}) {
  return createIssueAsrHandler({
    loadEnv: () => env,
    createServiceClient: () => client,
    authenticate: async () => userId,
    waitUntil: (p) => p
  });
}

function buildReportHandler(client, { userId = "user-1", env = BASE_ENV } = {}) {
  return createReportAsrHandler({
    loadEnv: () => env,
    createServiceClient: () => client,
    authenticate: async () => userId,
    waitUntil: (p) => p
  });
}

// === issue-asr-request ===

test("issue: no Authorization token -> 401 and no reservation", async () => {
  const client = createMockServiceClient();
  const handler = createIssueAsrHandler({
    loadEnv: () => BASE_ENV,
    createServiceClient: () => client,
    authenticate: async (authHeader) => (authHeader ? "user-1" : null),
    waitUntil: (p) => p
  });
  const response = await handler(new Request("https://edge/issue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ duration_ms: 1000, audio_size_bytes: 100 })
  }));
  const payload = await response.json();
  assert.equal(response.status, 401);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "unauthorized");
  assert.equal(client.rpcCalls.length, 0);
});

test("issue: quota error -> error code passthrough (429) and rejected usage row", async () => {
  const client = createMockServiceClient({ reservation: { errorCode: "quota_exceeded" } });
  const handler = buildIssueHandler(client);
  const response = await handler(authedRequest({ duration_ms: 2000, audio_size_bytes: 200 }));
  const payload = await response.json();
  assert.equal(response.status, 429);
  assert.equal(payload.code, "quota_exceeded");
  assert.equal(client.inserts.length, 1);
  assert.equal(client.inserts[0].status, "rejected");
  assert.equal(client.inserts[0].error_code, "quota_exceeded");
  // No signature was issued.
  assert.equal(payload.url, undefined);
});

test("issue: happy path returns url+headers+request_id and signs only after reservation", async () => {
  const client = createMockServiceClient();
  const signCalls = [];
  const handler = createIssueAsrHandler({
    loadEnv: () => BASE_ENV,
    createServiceClient: () => client,
    authenticate: async () => "user-1",
    waitUntil: (p) => p,
    signFlashRequest: async (args) => {
      signCalls.push(args);
      return {
        url: `https://asr.cloud.tencent.com/asr/flash/v1/${args.config.appId}?engine_type=16k_zh`,
        headers: { Authorization: "c2lnbmF0dXJl", "Content-Type": "application/octet-stream" }
      };
    }
  });
  const response = await handler(authedRequest({ duration_ms: 1500, audio_size_bytes: 3200 }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.ok(payload.request_id);
  assert.match(payload.url, /^https:\/\/asr\.cloud\.tencent\.com\/asr\/flash\/v1\/123456\?/);
  assert.ok(payload.headers.Authorization);
  assert.ok(payload.headers["Content-Type"]);
  // 密钥绝不下发：响应中只有签名和公共参数。
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("secret-key"));
  assert.ok(!serialized.includes("secretKey"));

  const rpc = client.rpcCalls[0];
  assert.equal(rpc.fn, "reserve_and_get_plan");
  assert.equal(rpc.params.p_provider, "tencent_cloud");
  assert.equal(rpc.params.p_mode, "cloud");
  assert.equal(rpc.params.p_audio_duration_ms, 1500);
  assert.equal(rpc.params.p_audio_size_bytes, 3200);
  assert.equal(rpc.params.p_request_id, payload.request_id);

  // Reservation happened before signing, and the reserved row exists.
  assert.equal(signCalls.length, 1);
  assert.equal(client.rows.get(payload.request_id).status, "reserved");
  assert.equal(signCalls[0].config.appId, "123456");

  // expires_at = 签名时间戳 + 300。
  assert.equal(payload.expires_at, signCalls[0].timestamp + DIRECT_ASR_SIGNATURE_TTL_SECONDS);
});

test("issue: missing TENCENT_APP_ID -> direct_asr_unavailable and reserved row closed as failed", async () => {
  const client = createMockServiceClient();
  const env = { ...BASE_ENV, tencent: { ...TENCENT_ENV, appId: undefined } };
  const handler = buildIssueHandler(client, { env });
  const response = await handler(authedRequest({ duration_ms: 1000, audio_size_bytes: 100 }));
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "direct_asr_unavailable");
  const row = [...client.rows.values()][0];
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "direct_asr_unavailable");
});

test("issue: invalid body -> 400 and no reservation", async () => {
  const client = createMockServiceClient();
  const handler = buildIssueHandler(client);
  const response = await handler(authedRequest({}));
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.code, "invalid_request");
  assert.equal(client.rpcCalls.length, 0);
});

// === report-asr-result ===

function reportRequest(body) {
  return new Request("https://edge/functions/v1/report-asr-result", {
    method: "POST",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function seedReserved(client) {
  const issue = buildIssueHandler(client);
  const issued = await issue(authedRequest({ duration_ms: 1000, audio_size_bytes: 100 }));
  return (await issued.json()).request_id;
}

test("report: closes reserved -> success", async () => {
  const client = createMockServiceClient();
  const requestId = await seedReserved(client);
  const handler = buildReportHandler(client);
  const response = await handler(reportRequest({ request_id: requestId, status: "success", text_length: 12 }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(client.rows.get(requestId).status, "success");
  assert.equal(Object.keys(payload).length, 1); // 只回 {ok:true}，绝不回显文本。
});

test("report: closes reserved -> failed with error code", async () => {
  const client = createMockServiceClient();
  const requestId = await seedReserved(client);
  const handler = buildReportHandler(client);
  const response = await handler(reportRequest({ request_id: requestId, status: "failed", error_code: "asr_http_error" }));
  assert.equal(response.status, 200);
  const row = client.rows.get(requestId);
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "asr_http_error");
});

test("report: second call on already-closed row is an idempotent no-op", async () => {
  const client = createMockServiceClient();
  const requestId = await seedReserved(client);
  const handler = buildReportHandler(client);
  await handler(reportRequest({ request_id: requestId, status: "success" }));
  // 迟到的失败上报不能把成功覆盖成失败。
  await handler(reportRequest({ request_id: requestId, status: "failed", error_code: "late_error" }));
  const row = client.rows.get(requestId);
  assert.equal(row.status, "success");
  assert.equal(row.error_code, null);
});

test("report: no token -> 401", async () => {
  const client = createMockServiceClient();
  const handler = createReportAsrHandler({
    loadEnv: () => BASE_ENV,
    createServiceClient: () => client,
    authenticate: async (authHeader) => (authHeader ? "user-1" : null),
    waitUntil: (p) => p
  });
  const response = await handler(new Request("https://edge/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: "r1", status: "success" })
  }));
  assert.equal(response.status, 401);
});
