import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import qrcode from "qrcode-terminal";

import { loadConfig } from "./config.js";
import { getLocalIp } from "./network/getLocalIp.js";
import { createLanServer } from "./createLanServer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(rootDir, ".env") });

try {
  console.log("Cleaning up leftover temp files...");
  const tmpDir = path.join(rootDir, "tmp");
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  console.log("Temp directory ready.");
} catch (err) {
  console.error("Failed to clean temp directory:", err.message);
}

const config = loadConfig();
const lan = await createLanServer({ rootDir, config });

const localIp = getLocalIp();
const phoneUrl = `https://${localIp}:${lan.port}`;

console.log("\nVoiceBridge is running.");
console.log(`Local:   https://localhost:${lan.port}`);
console.log(`Phone:   ${phoneUrl}`);
console.log(`ASR:     ${config.asrProvider} (${config.tencentAsrEngServiceType})`);
console.log(`Paste:   ${config.autoPaste ? "auto paste enabled" : "clipboard only"}`);
console.log(`HTTP redirect: http://localhost:${lan.httpPort} → HTTPS`);
console.log("\nScan this QR code from your phone:");
console.log('(手机首次访问会提示"不安全"，点击"高级" → "继续访问"即可)');
qrcode.generate(phoneUrl, { small: true });

if (!config.tencentSecretId || !config.tencentSecretKey) {
  console.warn("\nWarning: Tencent Cloud credentials are empty. Uploads will fail until .env is configured.");
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

async function shutdown() {
  await lan.close();
  process.exit(0);
}
