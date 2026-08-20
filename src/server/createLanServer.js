import http from "node:http";
import https from "node:https";
import path from "node:path";
import fs from "node:fs/promises";

import express from "express";

import { buildPublicConfig, loadConfig } from "./config.js";
import { listLocalIps, getLocalIp } from "./network/getLocalIp.js";
import { createUploadRouter } from "./routes/upload.js";
import { createCommandsRouter } from "./routes/commands.js";
import { createWebSocketHub } from "./ws.js";
import { createLanPairing } from "./lanPairing.js";
import { ensureCertificates } from "./certs.js";
import { listWindows } from "./input/windowManager.js";

/**
 * 可嵌入的 LAN 服务工厂：构建 HTTPS 主服务（自签名证书）+ WS hub +
 * HTTP 探测/重定向服务。供 `node src/server/index.js`（独立运行）和
 * Electron 云模式桌面端（内嵌）共用。
 *
 * @param {object} [options]
 * @param {string} options.rootDir 项目根目录（public / shared 静态资源相对此目录，可为 asar 内只读路径）
 * @param {object} [options.config] 已加载的配置（默认 loadConfig()）
 * @param {number} [options.port] HTTPS 端口（默认 config.port；0 = 随机分配）
 * @param {number} [options.httpPort] HTTP 探测/重定向端口（默认 HTTPS 端口 + 1）
 * @param {string} [options.certsDir] 证书目录（可写路径；默认 rootDir/certs。Electron 打包后必须传 userData 下的目录）
 * @param {string} [options.tmpDir] 上传临时目录（可写路径；默认 rootDir/tmp。Electron 打包后必须传 userData 下的目录）
 * @param {() => Promise<string|null>} [options.getAccessToken] Supabase 会话 access token 提供者
 *   （Electron 内嵌时来自 agent 匿名会话）。提供后，本地缺少腾讯云凭证时上传识别
 *   改走 Edge 逐次签名直连通道（密钥永不出云端）。
 * @param {string} [options.supabaseUrl] Edge 所在 Supabase URL（默认 config.supabaseUrl）
 * @param {string} [options.supabaseAnonKey] Supabase anon key（默认 config.supabaseAnonKey）
 * @param {object} [options.logger] 错误日志输出（默认 console）
 * @returns {Promise<{port: number, httpPort: number, close: () => Promise<void>, getEndpoints: () => Array<{host: string, port: number, httpPort: number}>}>}
 */
export async function createLanServer({
  rootDir,
  config = loadConfig(),
  port,
  httpPort,
  certsDir,
  tmpDir,
  getAccessToken,
  supabaseUrl,
  supabaseAnonKey,
  onPairingKnock,
  logger = console
} = {}) {
  if (!rootDir) {
    throw new Error("createLanServer requires rootDir");
  }

  // Edge 直连识别上下文（Task 5）：只在本地缺少腾讯云凭证时由 transcriber 启用。
  const edgeAsr = (typeof getAccessToken === "function" && (supabaseUrl ?? config.supabaseUrl))
    ? {
      getAccessToken,
      supabaseUrl: supabaseUrl ?? config.supabaseUrl,
      supabaseAnonKey: supabaseAnonKey ?? config.supabaseAnonKey
    }
    : null;

  const publicDir = path.join(rootDir, "src/public");
  const uploadTmpDir = tmpDir ?? path.join(rootDir, "tmp");
  await fs.mkdir(uploadTmpDir, { recursive: true });

  const localIp = getLocalIp();
  const { key, cert } = await ensureCertificates(rootDir, { localIp, certsDir });

  // ---- HTTPS 主服务 ----
  const app = express();
  const tlsServer = https.createServer({ key, cert }, app);

  app.use(express.json());
  app.use(express.static(publicDir, { maxAge: "7d", etag: true }));
  app.use("/shared", express.static(path.join(rootDir, "src/shared")));

  app.get("/config.js", (_req, res) => {
    res.type("application/javascript");
    res.set("Cache-Control", "no-store");
    res.send(`window.__VB_CONFIG = ${JSON.stringify(buildPublicConfig(config))};`);
  });

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
  // ---- 局域网配对门禁 ----
  // /api/health 与配对接口本身保持开放；其余 /api 路由和 WS 需要配对 token
  //（本机回环访问免配对，本地开发不受影响）。手机端在 LAN 页面输入配对码。
  const pairing = createLanPairing();
  app.get("/api/lan/pair", (req, res) => {
    const paired = pairing.isAuthorizedRequest(req);
    res.json({ ok: true, paired });
    // 敲门：未携带有效 token 的客户端（手机 LAN 页面加载时的状态探测）
    // 到达即通知桌面端"按需亮码"——平时不显示配对码，手机来了才展示
    //（带 TTL 自动隐藏）。回环开发访问也会敲门，行为一致且可测试。
    if (!pairing.hasValidToken(req)) {
      try {
        onPairingKnock?.(req);
      } catch { /* 敲门回调绝不能影响响应 */ }
    }
  });
  app.post("/api/lan/pair", (req, res) => {
    // 暴力破解防护：连续失败后按 IP 指数退避（内存状态）
    const retryAfterMs = pairing.getRetryAfterMs(req);
    if (retryAfterMs > 0) {
      res.status(429)
        .set("Retry-After", String(Math.ceil(retryAfterMs / 1000)))
        .json({ ok: false, error: "尝试过于频繁，请稍后再试。" });
      return;
    }
    const token = pairing.pair(req.body?.code, req);
    if (!token) {
      res.status(403).json({ ok: false, error: "配对码错误。" });
      return;
    }
    res.json({ ok: true, token });
  });
  app.use("/api", pairing.createMiddleware());

  app.get("/api/windows", async (_req, res) => {
    try {
      const windows = await listWindows();
      res.json({ ok: true, windows });
    } catch {
      res.json({ ok: true, windows: [] });
    }
  });
  app.use("/api", createCommandsRouter());

  // ---- HTTP 探测 / 重定向服务 ----
  // 云模式 PWA（https 页面）无法 fetch 自签名 HTTPS，但可以探测这个
  // 明文 HTTP 端口：/api/health 返回 200 证明桌面端可达。
  const redirectApp = express();
  redirectApp.get("/api/health", (_req, res) => {
    res.json({ ok: true, app: "VoiceBridge", lan: true });
  });
  redirectApp.use((req, res) => {
    // 手机从 HTTP 探测端口进来时 Host 带的是 httpPort，不能拿它和
    // "主机:httpsPort" 整串比较——否则永远匹配不上、回退到 localhost，
    // 手机端就被重定向到自己身上。按主机名（去端口）白名单校验后，
    // 保留该主机名并拼上 HTTPS 端口。
    const allowedHosts = new Set([
      "localhost",
      "127.0.0.1",
      getLocalIp(),
      ...listLocalIps()
    ]);
    const requestedHost = String(req.headers.host || "");
    const requestedHostname = requestedHost.replace(/:\d+$/, "");
    const safeHost = allowedHosts.has(requestedHostname)
      ? `${requestedHostname}:${resolvedPort}`
      : `localhost:${resolvedPort}`;
    const safePath = req.url.replace(/^\/+/, "/");
    res.redirect(301, `https://${safeHost}${safePath}`);
  });
  const redirectServer = http.createServer(redirectApp);

  const listen = (server, listenPort) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, "0.0.0.0", () => {
        server.off("error", reject);
        resolve(server.address().port);
      });
    });

  const closeServer = (server) =>
    new Promise((resolve) => {
      server.close(() => resolve());
      // close() 只等待 keep-alive 连接排空；强制销毁以避免悬挂。
      server.closeAllConnections?.();
    });

  const requestedPort = port ?? config.port;
  const resolvedPort = await listen(tlsServer, requestedPort);
  // 注意：WS hub 必须在 TLS listen 成功之后再挂载；端口冲突时提前挂载会让
  // ws 触发第二次未被捕获的 EADDRINUSE（见 createLanServer.test.js）。
  const wsHub = createWebSocketHub(tlsServer, {
    authorize: (req) => pairing.isAuthorizedRequest(req)
  });
  app.use("/api", createUploadRouter({ config, wsHub, tmpDir: uploadTmpDir, edgeAsr }));
  let resolvedHttpPort;
  try {
    resolvedHttpPort = await listen(redirectServer, httpPort ?? resolvedPort + 1);
  } catch (error) {
    // HTTP 端口被占用时不能留下已绑定的 TLS 服务和 WS hub —— 先关干净再抛出。
    try {
      wsHub.close();
    } catch (closeError) {
      logger.error?.("LAN WebSocket hub close failed during abort:", closeError?.message || closeError);
    }
    await closeServer(tlsServer);
    throw error;
  }

  return {
    port: resolvedPort,
    httpPort: resolvedHttpPort,
    /** 当前配对码（成功配对或 TTL 到期后自动轮换）：桌面端展示 */
    get pairingCode() {
      return pairing.code;
    },
    getEndpoints() {
      return listLocalIps().map((host) => ({
        host,
        port: resolvedPort,
        httpPort: resolvedHttpPort
      }));
    },
    async close() {
      try {
        wsHub.close();
      } catch (error) {
        logger.error?.("LAN WebSocket hub close failed:", error?.message || error);
      }
      await Promise.all([closeServer(tlsServer), closeServer(redirectServer)]);
    }
  };
}
