import test from "node:test";
import assert from "node:assert/strict";

import { createLanPairing, isLoopbackRequest } from "./lanPairing.js";

function fakeRequest({ remoteAddress = "192.168.1.50", url = "/", headers = {} } = {}) {
  return { socket: { remoteAddress }, url, headers };
}

test("createLanPairing issues a numeric code and exchanges it for a token", () => {
  const pairing = createLanPairing();
  assert.match(pairing.code, /^\d{6}$/);

  const token = pairing.pair(pairing.code);
  assert.equal(typeof token, "string");
  assert.equal(pairing.isValidToken(token), true);
  assert.equal(pairing.pair("wrong"), null);
});

test("pair rejects wrong codes", () => {
  const pairing = createLanPairing({ codeLength: 4 });
  assert.match(pairing.code, /^\d{4}$/);
  assert.equal(pairing.pair("nope"), null);
  assert.equal(pairing.pair(null), null);
  assert.equal(pairing.pair(123456), null);
});

test("tokens expire after tokenTtlMs", () => {
  let clock = 1000;
  const pairing = createLanPairing({ tokenTtlMs: 5000, now: () => clock });
  const token = pairing.pair(pairing.code);
  clock += 4999;
  assert.equal(pairing.isValidToken(token), true);
  clock += 2;
  assert.equal(pairing.isValidToken(token), false, "token should be expired");
  assert.equal(pairing.isValidToken(token), false, "expired token stays deleted");
});

test("isAuthorizedRequest accepts header token, query token and loopback", () => {
  const pairing = createLanPairing();
  const token = pairing.pair(pairing.code);

  assert.equal(pairing.isAuthorizedRequest(fakeRequest({ headers: { "x-vb-lan-token": token } })), true);
  assert.equal(pairing.isAuthorizedRequest(fakeRequest({ url: "/ws?token=" + encodeURIComponent(token) })), true);
  assert.equal(pairing.isAuthorizedRequest(fakeRequest({ headers: { "x-vb-lan-token": "forged" } })), false);
  assert.equal(pairing.isAuthorizedRequest(fakeRequest()), false, "no token -> denied");
  assert.equal(pairing.isAuthorizedRequest(fakeRequest({ remoteAddress: "127.0.0.1" })), true, "loopback exempt");
  assert.equal(isLoopbackRequest(fakeRequest({ remoteAddress: "::ffff:127.0.0.1" })), true);
});

test("middleware lets authorized requests through and 401s the rest", () => {
  const pairing = createLanPairing();
  const middleware = pairing.createMiddleware();
  const token = pairing.pair(pairing.code);

  let nextCalls = 0;
  middleware(fakeRequest({ headers: { "x-vb-lan-token": token } }), null, () => { nextCalls++; });
  middleware(fakeRequest({ remoteAddress: "::1" }), null, () => { nextCalls++; });
  assert.equal(nextCalls, 2);

  const sent = [];
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { sent.push({ code: this.statusCode, body }); }
  };
  middleware(fakeRequest(), res, () => { nextCalls++; });
  assert.equal(nextCalls, 2, "unauthorized request must not reach next()");
  assert.deepEqual(sent, [{ code: 401, body: { ok: false, error: "需要局域网配对，请在手机端输入配对码。" } }]);
});

test("each server instance generates an independent code", () => {
  const codes = new Set(Array.from({ length: 20 }, () => createLanPairing().code));
  assert.ok(codes.size > 1, "codes should not be constant");
});

// --- 配对码轮换 ---

test("pairing code rotates after successful pairing and becomes single-use", () => {
  let clock = 1000;
  const pairing = createLanPairing({ now: () => clock });
  const first = pairing.code;

  const token = pairing.pair(first);
  assert.equal(typeof token, "string");
  assert.notEqual(pairing.code, first, "code rotates after successful pairing");
  assert.equal(pairing.pair(first), null, "old code no longer works");
});

test("pairing code rotates after codeTtlMs", () => {
  let clock = 1000;
  const pairing = createLanPairing({ codeTtlMs: 600_000, now: () => clock });
  const initial = pairing.code;

  clock += 600_001;
  assert.notEqual(pairing.code, initial, "code rotates after TTL");
  assert.equal(pairing.pair(initial), null, "expired code no longer works");
});

// --- 按 IP 指数退避 ---

test("repeated failed attempts trigger per-IP exponential backoff with reset on success", () => {
  let clock = 0;
  const pairing = createLanPairing({
    maxFails: 5, backoffBaseMs: 1000, backoffCapMs: 60_000, now: () => clock
  });
  const brute = fakeRequest({ remoteAddress: "192.168.1.66" });
  const innocent = fakeRequest({ remoteAddress: "192.168.1.77" });

  for (let i = 0; i < 4; i++) {
    assert.equal(pairing.pair("000000", brute), null);
    assert.equal(pairing.getRetryAfterMs(brute), 0, "below maxFails no block yet");
  }
  assert.equal(pairing.pair("000000", brute), null); // 第 5 次失败
  assert.equal(pairing.getRetryAfterMs(brute), 1000);
  assert.equal(pairing.pair(pairing.code, brute), null, "blocked IP cannot pair even with the right code");

  clock += 1000; // 解禁
  assert.equal(pairing.getRetryAfterMs(brute), 0);

  // 正确配对码：成功并清零计数
  const token = pairing.pair(pairing.code, brute);
  assert.equal(typeof token, "string");
  assert.equal(pairing.getRetryAfterMs(brute), 0);
  for (let i = 0; i < 4; i++) pairing.pair("000000", brute);
  assert.equal(pairing.getRetryAfterMs(brute), 0, "failure counter was reset by success");

  // 其他 IP 不受影响
  assert.equal(pairing.getRetryAfterMs(innocent), 0);
  assert.equal(typeof pairing.pair(pairing.code, innocent), "string");
});

test("backoff doubles with each re-offense up to the cap", () => {
  let clock = 0;
  const pairing = createLanPairing({
    maxFails: 3, backoffBaseMs: 1000, backoffCapMs: 5000, now: () => clock
  });
  const req = fakeRequest({ remoteAddress: "10.0.0.9" });

  for (let i = 0; i < 3; i++) pairing.pair("000000", req); // 首次触发封禁
  assert.equal(pairing.getRetryAfterMs(req), 1000);

  for (const expected of [2000, 4000, 5000, 5000]) {
    clock += pairing.getRetryAfterMs(req); // 等待解禁后立刻再失败
    pairing.pair("000000", req);
    assert.equal(pairing.getRetryAfterMs(req), expected);
  }
});
