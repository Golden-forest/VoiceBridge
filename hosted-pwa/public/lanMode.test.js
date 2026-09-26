import test from "node:test";
import assert from "node:assert/strict";

import {
  LAN_TOKEN_STORAGE_KEY,
  CLOUD_ORIGIN_STORAGE_KEY,
  LanProbe,
  LanHealthWatch,
  buildLanUrl,
  buildLanWsUrl,
  buildNativeLanBaseUrl,
  createPairingClient,
  isLanPageEnvironment,
  isLoopbackHostname,
  lanTokenHeaders,
  normalizeEndpoints,
  probeEndpoint,
  probeLanEndpoints,
  resolveCloudOrigin,
  sanitizeCloudOrigin
} from "./lanMode.js";

const ENDPOINT_A = { host: "192.168.1.10", port: 3000, httpPort: 3001 };
const ENDPOINT_B = { host: "192.168.1.11", port: 3000, httpPort: 3001 };

function fakeFetch(responses) {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init });
    const handler = responses.find((entry) => entry.url === url);
    if (!handler) return Promise.reject(new Error("network error"));
    return handler.result instanceof Error ? Promise.reject(handler.result) : Promise.resolve(handler.result ?? {});
  };
  fn.calls = calls;
  return fn;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// --- 端点归一化 / 环境判定 ---

test("normalizeEndpoints drops malformed entries", () => {
  assert.deepEqual(normalizeEndpoints([
    ENDPOINT_A,
    null,
    { host: "", port: 1, httpPort: 2 },
    { host: "x", port: "3", httpPort: 4 },
    { host: "y", port: 5 },
    "junk"
  ]), [ENDPOINT_A]);
  assert.deepEqual(normalizeEndpoints(undefined), []);
});

test("isLanPageEnvironment distinguishes cloud, LAN page and local dev", () => {
  assert.equal(isLanPageEnvironment({ mode: "cloud", hostname: "192.168.1.5" }), false);
  assert.equal(isLanPageEnvironment({ mode: "local", hostname: "192.168.1.5" }), true);
  assert.equal(isLanPageEnvironment({ mode: "local", hostname: "localhost" }), false);
  assert.equal(isLanPageEnvironment({ mode: "local", hostname: "127.0.0.1" }), false);
  assert.equal(isLoopbackHostname("[::1]"), true);
});

// --- 探测 ---

test("probeEndpoint treats any response as reachable", async () => {
  const fetchImpl = fakeFetch([{ url: "http://192.168.1.10:3001/api/health", result: { ok: true } }]);
  assert.equal(await probeEndpoint(ENDPOINT_A, { fetchImpl }), true);
  assert.equal(fetchImpl.calls[0].init.mode, "no-cors");
});

test("probeEndpoint returns false on network failure and aborts pending fetch", async () => {
  const fetchImpl = fakeFetch([]);
  assert.equal(await probeEndpoint(ENDPOINT_A, { fetchImpl, timeoutMs: 50 }), false);

  // 永不返回的 fetch：超时中止信号必须让探测返回 false
  const slowFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  assert.equal(await probeEndpoint(ENDPOINT_A, { fetchImpl: slowFetch, timeoutMs: 20 }), false);
});

test("probeLanEndpoints probes in parallel and returns the first reachable in input order", async () => {
  const gates = [deferred(), deferred()];
  const fetchImpl = (url) => {
    const index = url.includes(ENDPOINT_A.host) ? 0 : 1;
    return gates[index].promise.then(() => ({}));
  };
  const promise = probeLanEndpoints([ENDPOINT_A, ENDPOINT_B], { fetchImpl });
  // 两个探测都已发起（并行），然后 B 先成功、A 失败
  await new Promise((resolve) => setTimeout(resolve, 5));
  gates[1].resolve({});
  gates[0].reject(new Error("unreachable"));
  assert.deepEqual(await promise, ENDPOINT_B);
});

test("probeLanEndpoints returns null when all endpoints fail", async () => {
  assert.equal(await probeLanEndpoints([ENDPOINT_A, ENDPOINT_B], { fetchImpl: fakeFetch([]) }), null);
  assert.equal(await probeLanEndpoints([], { fetchImpl: fakeFetch([]) }), null);
});

test("LanProbe caches results until TTL expiry or invalidation", async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; return Promise.resolve({}); };
  let clock = 1000;
  const probe = new LanProbe({ fetchImpl, cacheTtlMs: 5000, now: () => clock });

  probe.setEndpoints([ENDPOINT_A]);
  assert.deepEqual(await probe.getReachable(), ENDPOINT_A);
  assert.deepEqual(await probe.getReachable(), ENDPOINT_A);
  assert.equal(calls, 1, "cached within TTL");

  clock += 5001;
  assert.deepEqual(await probe.getReachable(), ENDPOINT_A);
  assert.equal(calls, 2, "re-probes after TTL");

  probe.invalidate();
  assert.deepEqual(await probe.getReachable(), ENDPOINT_A);
  assert.equal(calls, 3, "re-probes after invalidation");
});

test("LanProbe endpoint change invalidates cache and online/offline events re-probe", async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; return Promise.reject(new Error("down")); };
  const listeners = new Map();
  const win = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name)
  };
  const probe = new LanProbe({ fetchImpl, cacheTtlMs: 60_000, now: () => 0 });
  const unbind = probe.bindWindow(win);

  probe.setEndpoints([ENDPOINT_A]);
  assert.equal(await probe.getReachable(), null);
  assert.equal(await probe.getReachable(), null);
  assert.equal(calls, 1, "failure is also cached");

  listeners.get("online")();
  assert.equal(await probe.getReachable(), null);
  assert.equal(calls, 2, "online event re-probes");

  probe.setEndpoints([ENDPOINT_B]);
  assert.equal(await probe.getReachable(), null);
  assert.equal(calls, 3, "endpoint change re-probes");

  unbind();
  listeners.clear();
  assert.equal(listeners.size, 0);
});

// --- 云端来源 / URL 构建 ---

test("formatLanHost brackets IPv6 literals in probe and switch URLs", async () => {
  const ipv6 = { host: "fd00::1", port: 3000, httpPort: 3001 };
  const fetchImpl = fakeFetch([{ url: "http://[fd00::1]:3001/api/health", result: { ok: true } }]);
  assert.equal(await probeEndpoint(ipv6, { fetchImpl }), true);

  assert.equal(
    buildLanUrl(ipv6, "https://vb.pages.dev"),
    "https://[fd00::1]:3000/?cloud=https%3A%2F%2Fvb.pages.dev"
  );
  // 已带方括号 / IPv4 不受影响
  assert.equal(buildLanUrl({ host: "[fd00::2]", port: 3000 }, null), "https://[fd00::2]:3000/");
  assert.equal(buildLanUrl(ENDPOINT_A, null), "https://192.168.1.10:3000/");
});

test("sanitizeCloudOrigin only accepts https URLs", () => {
  assert.equal(sanitizeCloudOrigin("https://voicebridge.example.com/app?x=1"), "https://voicebridge.example.com");
  assert.equal(sanitizeCloudOrigin("http://voicebridge.example.com"), null);
  assert.equal(sanitizeCloudOrigin("javascript:alert(1)"), null);
  assert.equal(sanitizeCloudOrigin(""), null);
  assert.equal(sanitizeCloudOrigin("not a url"), null);
});

function fakeWindow({ search = "", stored = null } = {}) {
  const storage = new Map(stored ? [[CLOUD_ORIGIN_STORAGE_KEY, stored]] : []);
  return {
    location: { search, hostname: "192.168.1.20", protocol: "https:", host: "192.168.1.20:3000" },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    },
    __storage: storage
  };
}

test("resolveCloudOrigin persists the query param and falls back to storage", () => {
  const fromQuery = fakeWindow({ search: "?cloud=https%3A%2F%2Fvb.pages.dev" });
  assert.equal(resolveCloudOrigin(fromQuery), "https://vb.pages.dev");
  assert.equal(fromQuery.__storage.get(CLOUD_ORIGIN_STORAGE_KEY), "https://vb.pages.dev");

  const fromStorage = fakeWindow({ stored: "https://vb.pages.dev" });
  assert.equal(resolveCloudOrigin(fromStorage), "https://vb.pages.dev");

  const none = fakeWindow({ search: "?cloud=http%3A%2F%2Fbad.example" });
  assert.equal(resolveCloudOrigin(none), null);
});

test("buildLanUrl targets the https port and carries the sanitized cloud origin", () => {
  assert.equal(
    buildLanUrl(ENDPOINT_A, "https://vb.pages.dev/app"),
    "https://192.168.1.10:3000/?cloud=https%3A%2F%2Fvb.pages.dev"
  );
  assert.equal(buildLanUrl(ENDPOINT_A, null), "https://192.168.1.10:3000/");
  assert.equal(buildLanUrl(ENDPOINT_A, "http://evil.example"), "https://192.168.1.10:3000/");
});

// --- token 注入 / 配对客户端 ---

test("lanTokenHeaders and buildLanWsUrl inject the persisted token", () => {
  const withToken = fakeWindow();
  withToken.localStorage.setItem(LAN_TOKEN_STORAGE_KEY, "abc-123");
  assert.deepEqual(lanTokenHeaders(withToken), { "x-vb-lan-token": "abc-123" });
  assert.equal(buildLanWsUrl(withToken), "wss://192.168.1.20:3000/ws?token=abc-123");

  const withoutToken = fakeWindow();
  assert.deepEqual(lanTokenHeaders(withoutToken), {});
  assert.equal(buildLanWsUrl(withoutToken), "wss://192.168.1.20:3000/ws");

  const plainHttp = fakeWindow();
  plainHttp.location.protocol = "http:";
  plainHttp.location.host = "192.168.1.20:3001";
  plainHttp.localStorage.setItem(LAN_TOKEN_STORAGE_KEY, "t");
  assert.equal(buildLanWsUrl(plainHttp), "ws://192.168.1.20:3001/ws?token=t");

  assert.equal(buildNativeLanBaseUrl(ENDPOINT_A), "http://192.168.1.10:3001");
  assert.equal(
    buildLanWsUrl(withToken, ENDPOINT_A),
    "ws://192.168.1.10:3001/ws?token=abc-123"
  );
});

test("createPairingClient reports status and exchanges a code for a stored token", async () => {
  const win = fakeWindow();
  const fetchImpl = async (_url, init) => {
    if (init?.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: "tok-1" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, paired: false }) };
  };
  const client = createPairingClient({ fetchImpl, win });

  assert.deepEqual(await client.status(), { paired: false });

  const result = await client.pair("123456");
  assert.deepEqual(result, { ok: true, token: "tok-1" });
  assert.equal(win.localStorage.getItem(LAN_TOKEN_STORAGE_KEY), "tok-1");
});

test("createPairingClient surfaces pairing failure without storing anything", async () => {
  const win = fakeWindow();
  const fetchImpl = async (url, init) => {
    void url; void init;
    return { ok: false, status: 403, json: async () => ({ ok: false, error: "配对码错误。" }) };
  };
  const client = createPairingClient({ fetchImpl, win });
  assert.deepEqual(await client.pair("000000"), { ok: false });
  assert.equal(win.localStorage.getItem(LAN_TOKEN_STORAGE_KEY), null);
});

// --- 切换目标决策（presence 上报即展示，探测仅增强） ---

test("getSwitchTarget falls back to the first advertised endpoint when probes all fail", async () => {
  // 真实手机浏览器上 https 页面探测 http://<ip> 属 mixed content，必然 reject
  const fetchImpl = () => Promise.reject(new TypeError("mixed content blocked"));
  const probe = new LanProbe({ fetchImpl, cacheTtlMs: 60_000, now: () => 0 });
  probe.setEndpoints([ENDPOINT_A, ENDPOINT_B]);
  assert.deepEqual(await probe.getSwitchTarget(), ENDPOINT_A);
});

test("getSwitchTarget prefers a probe-confirmed reachable endpoint", async () => {
  const fetchImpl = (url) => {
    if (url.includes(ENDPOINT_B.host)) return Promise.resolve({});
    return Promise.reject(new Error("unreachable"));
  };
  const probe = new LanProbe({ fetchImpl, cacheTtlMs: 60_000, now: () => 0 });
  probe.setEndpoints([ENDPOINT_A, ENDPOINT_B]);
  assert.deepEqual(await probe.getSwitchTarget(), ENDPOINT_B);
});

test("getSwitchTarget returns null when nothing is advertised", async () => {
  const probe = new LanProbe({ fetchImpl: () => Promise.reject(new Error("down")) });
  probe.setEndpoints([]);
  assert.equal(await probe.getSwitchTarget(), null);
});

// --- 失联回退 ---

test("LanHealthWatch triggers fallback once after consecutive failures and stops", async () => {
  const timers = [];
  const fetchImpl = async () => { throw new Error("server gone"); };
  let fallbacks = 0;
  const watch = new LanHealthWatch({
    fetchImpl,
    intervalMs: 10,
    failureThreshold: 2,
    onFallback: () => { fallbacks++; },
    setTimeoutImpl: (fn, ms) => { const id = { fn, ms }; timers.push(id); return id; },
    clearTimeoutImpl: (id) => { const i = timers.indexOf(id); if (i !== -1) timers.splice(i, 1); }
  });

  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fallbacks, 0, "one failure is not enough");

  const next = timers.shift();
  next.fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fallbacks, 1, "second consecutive failure triggers fallback");
  assert.equal(timers.length, 0, "watch stopped after fallback");

  // 再手动触发也不重复回调
  watch.poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fallbacks, 1);
});

test("LanHealthWatch resets the failure counter after a successful poll", async () => {
  const timers = [];
  let healthy = false;
  const fetchImpl = async () => { if (!healthy) throw new Error("down"); };
  let fallbacks = 0;
  const watch = new LanHealthWatch({
    fetchImpl,
    intervalMs: 10,
    failureThreshold: 2,
    onFallback: () => { fallbacks++; },
    setTimeoutImpl: (fn) => { const id = { fn }; timers.push(id); return id; },
    clearTimeoutImpl: (id) => { const i = timers.indexOf(id); if (i !== -1) timers.splice(i, 1); }
  });
  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  healthy = true;
  timers.shift().fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  healthy = false;
  timers.shift().fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fallbacks, 0, "success reset the counter — single later failure does not trigger");
  watch.stop();
  assert.equal(timers.length, 0);
});
