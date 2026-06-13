import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CERT_DIR = "certs";
const KEY_FILE = "key.pem";
const CERT_FILE = "cert.pem";

/**
 * 确保自签名 TLS 证书存在（若不存在则用 openssl 自动生成）。
 * @param {string} rootDir 项目根目录
 * @param {object} [opts]
 * @param {string} [opts.localIp] 局域网 IP，写入 SAN 以便手机访问
 * @returns {Promise<{ key: string, cert: string }>} PEM 格式的密钥和证书内容
 */
export async function ensureCertificates(rootDir, { localIp } = {}) {
  const certDir = path.join(rootDir, CERT_DIR);
  await fs.mkdir(certDir, { recursive: true });

  const keyPath = path.join(certDir, KEY_FILE);
  const certPath = path.join(certDir, CERT_FILE);

  let key, cert;

  try {
    key = await fs.readFile(keyPath, "utf-8");
    cert = await fs.readFile(certPath, "utf-8");
  } catch {
    const sanEntries = ["IP:127.0.0.1", "DNS:localhost"];
    if (localIp && localIp !== "127.0.0.1") sanEntries.push(`IP:${localIp}`);
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
