import assert from "node:assert/strict";
import test from "node:test";
import { createIssueAsrHandler, createReportAsrHandler } from "./direct_asr.ts";

for (const [name, create] of [["issue", createIssueAsrHandler], ["report", createReportAsrHandler]]) {
  test(`${name}: retired route cannot issue credentials or mutate usage`, async () => {
    const response = await create()(new Request("https://local.invalid/asr", {
      method: "POST", headers: { Authorization: "Bearer old-client-token" },
      body: JSON.stringify({ duration_ms: 1, audio_size_bytes: 1, status: "failed", request_id: "old-request" })
    }));
    const body = await response.json();
    assert.equal(response.status, 410);
    assert.equal(body.code, "direct_asr_retired");
    assert.equal(body.ok, false);
    assert.equal(body.url, undefined);
    assert.equal(body.headers, undefined);
  });
  test(`${name}: preflight and method handling remain available`, async () => {
    assert.equal((await create()(new Request("https://local.invalid/asr", { method: "OPTIONS" }))).status, 200);
    assert.equal((await create()(new Request("https://local.invalid/asr"))).status, 405);
  });
}
