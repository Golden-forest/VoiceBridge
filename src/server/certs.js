import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CERT_DIR = "certs";
const KEY_FILE = "key.pem";
const CERT_FILE = "cert.pem";

/**
 * 确保自签名 TLS 证书存在（若不存在则用 openssl 自动生成）。
 * @param {string} rootDir 项目根目录（默认证书目录的父目录）
 * @param {object} [opts]
 * @param {string} [opts.localIp] 局域网 IP，写入 SAN 以便手机访问
 * @param {string[]} [opts.localIps] 所有可用局域网 IP；证书必须覆盖所有广播端点
 * @param {string} [opts.certsDir] 证书目录（必须是可写路径；打包后的 asar 只读，
 *   Electron 端应传 userData 下的目录）
 * @returns {Promise<{ key: string, cert: string }>} PEM 格式的密钥和证书内容
 */
export async function ensureCertificates(rootDir, { localIp, localIps, certsDir } = {}) {
  const certDir = certsDir ?? path.join(rootDir, CERT_DIR);
  await fs.mkdir(certDir, { recursive: true });

  const keyPath = path.join(certDir, KEY_FILE);
  const certPath = path.join(certDir, CERT_FILE);

  const requestedIps = [...new Set([
    "127.0.0.1",
    ...(Array.isArray(localIps) ? localIps : [localIp]).filter(Boolean)
  ])];
  let key, cert;

  try {
    key = await fs.readFile(keyPath, "utf-8");
    cert = await fs.readFile(certPath, "utf-8");
    const parsed = new X509Certificate(cert);
    const expiresAt = Date.parse(parsed.validTo);
    const ipMatches = requestedIps.every((ip) => Boolean(parsed.checkIP(ip)));
    if (!ipMatches || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 24 * 60 * 60 * 1000) {
      throw new Error("stored LAN certificate no longer matches this network");
    }
  } catch {
    const sanEntries = ["DNS:localhost", ...requestedIps.map((ip) => `IP:${ip}`)];
    await execFileAsync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "3650",
      "-nodes",
      "-subj", "/CN=VoiceBridge/O=VoiceBridge/C=CN",
      "-addext", `subjectAltName=${sanEntries.join(",")}`
    ], { stdio: "pipe" });
    key = await fs.readFile(keyPath, "utf-8");
    cert = await fs.readFile(certPath, "utf-8");
  }

  return { key, cert };
}
