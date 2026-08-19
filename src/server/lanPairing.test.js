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
