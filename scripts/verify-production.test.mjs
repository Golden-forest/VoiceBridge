import test from "node:test";
import assert from "node:assert/strict";
import { verifyProduction } from "./verify-production.mjs";

const fixture = { config: { supabaseUrl: "https://test.invalid", supabaseAnonKey: "public-test" }, device: { id: "device-test" }, accessToken: "token-test" };
test("production verification defaults to status-only and accepts every supported plan", async () => {
  for (const plan of ["free", "pro", "admin"]) {
    const calls = [];
    const result = await verifyProduction({ ...fixture, fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return Response.json({ paired: true, plan, user_id: "owner-test" });
    } });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "read-only");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.action, "status");
    assert.match(calls[0].url, /device-pairing$/);
  }
});
test("authorization write probe requires explicit opt-in and fails on accepted update", async () => {
  for (const status of [403, 204]) {
    const methods = [];
    const result = await verifyProduction({ ...fixture, checkWriteAuthorization: true, fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return options.method === "PATCH" ? new Response(null, { status }) : Response.json({ paired: true, plan: "pro", user_id: "owner-test" });
    } });
    assert.deepEqual(methods, ["POST", "PATCH"]);
    assert.equal(result.ok, status === 403);
  }
});
