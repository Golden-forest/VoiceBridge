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
