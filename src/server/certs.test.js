import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureCertificates } from "./certs.js";

test("ensureCertificates reuses a certificate for the same LAN IP", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-cert-"));
  const first = await ensureCertificates(rootDir, { localIp: "192.168.10.20" });
  const second = await ensureCertificates(rootDir, { localIp: "192.168.10.20" });
  assert.equal(second.cert, first.cert);
  assert.equal(new X509Certificate(second.cert).checkIP("192.168.10.20"), "192.168.10.20");
});

test("ensureCertificates regenerates when the LAN IP changes", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-cert-"));
  const first = await ensureCertificates(rootDir, { localIp: "192.168.10.20" });
  const second = await ensureCertificates(rootDir, { localIp: "192.168.10.21" });
  assert.notEqual(second.cert, first.cert);
  assert.equal(new X509Certificate(second.cert).checkIP("192.168.10.21"), "192.168.10.21");
});

test("ensureCertificates covers every advertised LAN endpoint", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-cert-"));
  const result = await ensureCertificates(rootDir, {
    localIps: ["192.168.10.20", "10.0.0.8"]
  });
  const cert = new X509Certificate(result.cert);
  assert.equal(cert.checkIP("192.168.10.20"), "192.168.10.20");
  assert.equal(cert.checkIP("10.0.0.8"), "10.0.0.8");
});
