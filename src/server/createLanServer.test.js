import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createLanServer } from "./createLanServer.js";
import { listLocalIps } from "./network/getLocalIp.js";

function httpsGetJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: "127.0.0.1", port, path: pathname, rejectUnauthorized: false },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }
    );
    req.on("error", reject);
  });
}

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
  });
}

function portClosed(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", agent: false }, () => resolve(false));
    req.on("error", (error) => resolve(error.code === "ECONNREFUSED"));
  });
}

function httpsPostJson(port, pathname, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        rejectUnauthorized: false
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* ignore */ }
          resolve({ status: res.statusCode, retryAfter: res.headers["retry-after"], body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("createLanServer starts, serves health on both ports, and stops cleanly", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));

  const lan = await createLanServer({ rootDir, port: 0, config: {} });

  assert.ok(lan.port > 0);
  assert.equal(lan.httpPort, lan.port + 1);

  const tlsHealth = await httpsGetJson(lan.port, "/api/health");
  assert.equal(tlsHealth.status, 200);
  assert.equal(tlsHealth.body.ok, true);
  assert.equal(tlsHealth.body.app, "VoiceBridge");

  const plainHealth = await httpGet(lan.httpPort, "/api/health");
  assert.equal(plainHealth.status, 200);

  const redirect = await httpGet(lan.httpPort, "/some/path");
  assert.equal(redirect.status, 301);

  await lan.close();

  assert.equal(await portClosed(lan.port), true, "https port should be closed");
  assert.equal(await portClosed(lan.httpPort), true, "http port should be closed");
});

test("createLanServer getEndpoints lists local IPv4 addresses with both ports", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
  const lan = await createLanServer({ rootDir, port: 0, config: {} });

  const endpoints = lan.getEndpoints();

  assert.ok(Array.isArray(endpoints) && endpoints.length > 0);
  assert.deepEqual(endpoints.map((endpoint) => endpoint.host), listLocalIps());
  for (const endpoint of endpoints) {
    assert.equal(endpoint.port, lan.port);
    assert.equal(endpoint.httpPort, lan.httpPort);
  }

  await lan.close();
});

test("createLanServer rejects when a fixed port is already taken", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "0.0.0.0", resolve));
  const takenPort = blocker.address().port;

  await assert.rejects(
    createLanServer({ rootDir, port: takenPort, config: {} }),
    /EADDRINUSE/
  );

  await new Promise((resolve) => blocker.close(resolve));
});

test("createLanServer requires rootDir", async () => {
  await assert.rejects(createLanServer({}), /rootDir/);
});

test("createLanServer exposes a pairing code and loopback access is pre-authorized", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
  const lan = await createLanServer({ rootDir, port: 0, config: {} });

  assert.match(lan.pairingCode, /^\d{6}$/);

  // 回环（本机开发）免配对
  const loopback = await httpsGetJson(lan.port, "/api/lan/pair");
  assert.equal(loopback.status, 200);
  assert.deepEqual(loopback.body, { ok: true, paired: true });

  await lan.close();
});

test("createLanServer rotates the pairing code on use and rate-limits brute force", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
  const lan = await createLanServer({ rootDir, port: 0, config: {} });

  // 成功配对：返回 token，配对码立即轮换（一次性）
  const first = lan.pairingCode;
  const paired = await httpsPostJson(lan.port, "/api/lan/pair", { code: first });
  assert.equal(paired.status, 200);
  assert.equal(typeof paired.body.token, "string");
  assert.notEqual(lan.pairingCode, first, "code rotates after successful pairing");
  assert.equal((await httpsPostJson(lan.port, "/api/lan/pair", { code: first })).status, 403);

  // 连续错误：累计 5 次失败（上面的旧码 403 已计 1 次）后进入按 IP 指数退避
  for (let i = 0; i < 4; i++) {
    assert.equal((await httpsPostJson(lan.port, "/api/lan/pair", { code: "000000" })).status, 403);
  }
  const limited = await httpsPostJson(lan.port, "/api/lan/pair", { code: "000000" });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.retryAfter) >= 1, "Retry-After header in whole seconds");
  assert.equal(limited.body.ok, false);

  await lan.close();
});

test("createLanServer closes the HTTPS server when the HTTP port is taken", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "0.0.0.0", resolve));
  const httpsPort = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "0.0.0.0", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });

  await assert.rejects(
    createLanServer({ rootDir, port: httpsPort, httpPort: blocker.address().port, config: {} }),
    /EADDRINUSE/
  );

  // 部分绑定泄漏：HTTPS 端口必须已被释放，而不是继续监听。
  assert.equal(await portClosed(httpsPort), true, "https port should be released after http bind failure");

  await new Promise((resolve) => blocker.close(resolve));
});

test("createLanServer honors separate writable certsDir and tmpDir", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
  const writableDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-writable-"));

  const lan = await createLanServer({
    rootDir,
    config: {},
    certsDir: path.join(writableDir, "certs"),
    tmpDir: path.join(writableDir, "tmp")
  });

  await lan.close();

  const certsEntries = await fs.readdir(path.join(writableDir, "certs"));
  assert.ok(certsEntries.includes("key.pem") && certsEntries.includes("cert.pem"));
  // 只读 rootDir 下不应再生成 certs / tmp。
  await assert.rejects(fs.readdir(path.join(rootDir, "certs")), /ENOENT/);
  await assert.rejects(fs.readdir(path.join(rootDir, "tmp")), /ENOENT/);
});
