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

function httpGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, agent: false, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on("error", reject);
  });
}

function httpGetJson(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, agent: false, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: JSON.parse(body)
      }));
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

test("createLanServer notifies onPairingKnock when an unpaired phone probes the pairing endpoint", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
  const knocks = [];
  const lan = await createLanServer({
    rootDir,
    port: 0,
    config: {},
    onPairingKnock: (req) => knocks.push(req.socket?.remoteAddress || "unknown")
  });

  try {
    // 手机（LAN 页面加载时的 status 探测）→ 敲门。
    await httpsGetJson(lan.port, "/api/lan/pair");
    assert.equal(knocks.length, 1);
  } finally {
    await lan.close();
  }
});

test("createLanServer exposes token-protected APIs to the packaged native app over HTTP", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
  const lan = await createLanServer({ rootDir, port: 0, config: {} });

  try {
    const response = await httpGetJson(lan.httpPort, "/api/lan/pair", {
      Origin: "capacitor://localhost"
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, paired: true });
    assert.equal(response.headers["access-control-allow-origin"], "capacitor://localhost");
  } finally {
    await lan.close();
  }
});

test("createLanServer HTTP redirect keeps the phone's host instead of falling back to localhost", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
  const lan = await createLanServer({ rootDir, port: 0, config: {} });

  try {
    // 手机访问 HTTP 探测端口时 Host 头带的是 httpPort；重定向必须保留
    // 该主机名并指向 HTTPS 端口，否则手机会被跳到"localhost"（它自己）。
    const redirect = await httpGet(lan.httpPort, "/some/path", {
      Host: `127.0.0.1:${lan.httpPort}`
    });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.location, `https://127.0.0.1:${lan.port}/some/path`);

    // 未知主机名仍回退到 localhost（防开放重定向）。
    const unknown = await httpGet(lan.httpPort, "/x", { Host: "evil.example:1234" });
    assert.equal(unknown.location, `https://localhost:${lan.port}/x`);
  } finally {
    await lan.close();
  }
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

test("createLanServer persists pairing tokens across close and recreate", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
  const tokensPath = path.join(rootDir, "lan-pairing.json");

  let token;
  {
    const lan = await createLanServer({ rootDir, port: 0, config: {}, pairingTokensPath: tokensPath });
    token = (await httpsPostJson(lan.port, "/api/lan/pair", { code: lan.pairingCode })).body.token;
    assert.equal(typeof token, "string");
    await lan.close();
  }

  // close() flush：配对 token 立即落盘（不依赖 5s 防抖），服务重建后可恢复。
  const persisted = JSON.parse(await fs.readFile(tokensPath, "utf8"));
  assert.ok(Array.isArray(persisted.tokens) && persisted.tokens.some((entry) => entry.token === token));

  {
    const lan = await createLanServer({ rootDir, port: 0, config: {}, pairingTokensPath: tokensPath });
    // 重建后的实例正常工作（配对码独立、健康检查可达）。
    const health = await httpsGetJson(lan.port, "/api/health");
    assert.equal(health.body.ok, true);
    await lan.close();
    // 再次落盘不丢历史 token。
    const repersisted = JSON.parse(await fs.readFile(tokensPath, "utf8"));
    assert.ok(repersisted.tokens.some((entry) => entry.token === token));
  }

  // 不传 pairingTokensPath：纯内存行为，绝不写文件。
  {
    const memDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-"));
    const memTokensPath = path.join(memDir, "lan-pairing.json");
    const lan = await createLanServer({ rootDir: memDir, port: 0, config: {}, pairingTokensPath: undefined });
    await httpsPostJson(lan.port, "/api/lan/pair", { code: lan.pairingCode });
    await lan.close();
    await assert.rejects(fs.readFile(memTokensPath, "utf8"), /ENOENT/);
  }
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

// --- Task 5: Edge 签名直连识别通过 createLanServer 选项打通 ---

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);

async function hasFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function startStubEdgeServer() {
  const seen = { issue: null, report: null, tencentBody: null };
  let tencentUrl = "";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.url === "/functions/v1/issue-asr-request") {
        seen.issue = { headers: req.headers, body: JSON.parse(raw.toString("utf8")) };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          ok: true,
          request_id: "req-lan-1",
          url: `${tencentUrl}/asr`,
          headers: { "X-TC-Test": "signed" },
          expires_at: Math.floor(Date.now() / 1000) + 300
        }));
        return;
      }
      if (req.url === "/functions/v1/report-asr-result") {
        seen.report = JSON.parse(raw.toString("utf8"));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/asr") {
        seen.tencentBody = raw;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ code: 0, flash_result: [{ text: "嗯，你好局域网" }] }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return {
    server,
    seen,
    setTencentUrl: (url) => { tencentUrl = url; },
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
  };
}

function makeSilenceWav() {
  // 16kHz / 16bit / mono 静音 WAV（ffmpeg 可直接读取）。
  const sampleRate = 16000;
  const samples = 1600;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function httpsPostMultipart(port, pathname, fieldName, filename, contentType, fileBuffer) {
  const boundary = `----vb${Date.now()}`;
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    fileBuffer,
    `\r\n--${boundary}--\r\n`
  ];
  const body = Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length
        },
        rejectUnauthorized: false
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* ignore */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("createLanServer routes uploads through the edge-signed channel when local tencent credentials are absent", { skip: !(await hasFfmpeg()) }, async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-lan-edge-"));
  const stub = startStubEdgeServer();
  const stubPort = await stub.listen();
  stub.setTencentUrl(`http://127.0.0.1:${stubPort}`);
  let tokenCalls = 0;

  const lan = await createLanServer({
    rootDir,
    deviceId: "11111111-1111-4111-8111-111111111111",
    port: 0,
    config: { asrProvider: "tencent", tencentSecretId: "", tencentSecretKey: "" },
    supabaseUrl: `http://127.0.0.1:${stubPort}`,
    supabaseAnonKey: "anon-test",
    getAccessToken: async () => {
      tokenCalls += 1;
      return "lan-token";
    }
  });

  try {
    const wav = makeSilenceWav();
    const result = await httpsPostMultipart(lan.port, "/api/upload", "audio", "voice.wav", "audio/wav", wav);

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    // 语气词清理与 Edge/客户端版本一致
    assert.equal(result.body.text, "你好局域网");

    assert.equal(tokenCalls, 1, "token provider is plumbed through createLanServer options");
    assert.equal(stub.seen.issue.headers.authorization, "Bearer lan-token");
    assert.equal(stub.seen.issue.headers.apikey, "anon-test");
    assert.ok(stub.seen.issue.body.duration_ms > 0);
    assert.equal(stub.seen.issue.body.device_id, "11111111-1111-4111-8111-111111111111");
    assert.ok(stub.seen.tencentBody && stub.seen.tencentBody.length > 44, "converted wav posted to signed tencent url");
    assert.deepEqual(stub.seen.report, {
      request_id: "req-lan-1",
      status: "success",
      device_id: "11111111-1111-4111-8111-111111111111",
      text_length: "你好局域网".length,
      duration_ms: 101 // makeSilenceWav 的固定时长，随上报结算实际用量
    });
  } finally {
    await lan.close();
    await new Promise((resolve) => stub.server.close(resolve));
  }
});
