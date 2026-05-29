import http from "node:http";
import https from "node:https";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";
import qrcode from "qrcode-terminal";

import { loadConfig } from "./config.js";
import { getLocalIp } from "./network/getLocalIp.js";
import { createUploadRouter } from "./routes/upload.js";
import { createCommandsRouter } from "./routes/commands.js";
import { createWebSocketHub } from "./ws.js";
import { ensureCertificates } from "./certs.js";
import { listWindows } from "./input/windowManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(rootDir, ".env") });
const publicDir = path.join(rootDir, "src/public");
const tmpDir = path.join(rootDir, "tmp");

await fs.mkdir(tmpDir, { recursive: true });

const config = loadConfig();
const { key, cert } = await ensureCertificates(rootDir);

// ---- HTTPS 主服务 ----
const app = express();
const tlsServer = https.createServer({ key, cert }, app);
const wsHub = createWebSocketHub(tlsServer);

app.use(express.json());
app.use(express.static(publicDir));
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "VoiceBridge",
    autoPaste: config.autoPaste,
    asrProvider: config.asrProvider,
    tencentAsrEngServiceType: config.tencentAsrEngServiceType,
    hasTencentCredentials: Boolean(config.tencentSecretId && config.tencentSecretKey)
  });
});
app.get("/api/windows", async (_req, res) => {
  try {
    const windows = await listWindows();
    res.json({ ok: true, windows });
  } catch {
    res.json({ ok: true, windows: [] });
  }
});
app.use("/api", createUploadRouter({ config, wsHub, tmpDir }));
app.use("/api", createCommandsRouter());

// ---- HTTP → HTTPS 重定向服务 ----
const redirectApp = express();
redirectApp.use((req, res) => {
  const host = req.headers.host || `localhost:${config.port}`;
  res.redirect(301, `https://${host}${req.url}`);
});
const redirectServer = http.createServer(redirectApp);

tlsServer.listen(config.port, "0.0.0.0", () => {
  const localIp = getLocalIp();
  const phoneUrl = `https://${localIp}:${config.port}`;

  console.log("\nVoiceBridge is running.");
  console.log(`Local:   https://localhost:${config.port}`);
  console.log(`Phone:   ${phoneUrl}`);
  console.log(`ASR:     ${config.asrProvider} (${config.tencentAsrEngServiceType})`);
  console.log(`Paste:   ${config.autoPaste ? "auto paste enabled" : "clipboard only"}`);
  console.log("\nScan this QR code from your phone:");
  console.log('(手机首次访问会提示"不安全"，点击"高级" → "继续访问"即可)');
  qrcode.generate(phoneUrl, { small: true });

  if (!config.tencentSecretId || !config.tencentSecretKey) {
    console.warn("\nWarning: Tencent Cloud credentials are empty. Uploads will fail until .env is configured.");
  }
});

redirectServer.listen(config.port + 1, "0.0.0.0", () => {
  console.log(`HTTP redirect: http://localhost:${config.port + 1} → HTTPS`);
});

function shutdown() {
  wsHub.close();
  tlsServer.close();
  redirectServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
