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
import { isTrustedLanOrigin, NATIVE_LAN_ORIGINS } from "./lanOrigins.js";
import { ensureCertificates } from "./certs.js";
import { listWindows } from "./input/windowManager.js";

const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

// 进程崩溃 / 断电时上传的音频会残留在 tmp 目录（正常路径在 finally 里删除）。
// 启动时清理超过一天的孤儿文件，避免长期运行的磁盘垃圾积累。尽力而为，
// 失败不影响服务启动。
function sweepStaleUploads(dir, now = Date.now()) {
  fs.readdir(dir).then((entries) => {
    for (const entry of entries) {
      const filePath = path.join(dir, entry);
      fs.stat(filePath).then((stats) => {
        if (stats.isFile() && now - stats.mtimeMs > STALE_UPLOAD_MS) {
          return fs.rm(filePath, { force: true });
        }
      }).catch(() => { /* best effort */ });
    }
  }).catch(() => { /* best effort */ });
}

/**
 * 可嵌入的 LAN 服务工厂：构建 HTTPS 主服务（自签名证书）+ WS hub +
 * HTTP 探测/重定向服务。供 `node src/server/index.js`（独立运行）和
 * Electron 云模式桌面端（内嵌）共用。
 *
 * @param {object} [options]
 * @param {string} options.rootDir 项目根目录（public / shared 静态资源相对此目录，可为 asar 内只读路径）
 * @param {string} [options.deviceId] 已绑定的桌面设备 ID；匿名运行会话凭此代理到真实账号
 * @param {object} [options.config] 已加载的配置（默认 loadConfig()）
 * @param {number} [options.port] HTTPS 端口（默认 config.port；0 = 随机分配）
 * @param {number} [options.httpPort] HTTP 探测/重定向端口（默认 HTTPS 端口 + 1）
 * @param {string} [options.certsDir] 证书目录（可写路径；默认 rootDir/certs。Electron 打包后必须传 userData 下的目录）
 * @param {string} [options.tmpDir] 上传临时目录（可写路径；默认 rootDir/tmp。Electron 打包后必须传 userData 下的目录）
 * @param {string} [options.pairingTokensPath] 配对 token 持久化 JSON（可写路径；不传则纯内存——
 *   服务重启后需要重新输配对码。Electron 内嵌模式必须传 userData 下的路径：asar 只读，
 *   且 token 属于与登录态同信任级的本机凭证，不应放进应用包目录）
 * @param {() => Promise<string|null>} [options.getAccessToken] Supabase 会话 access token 提供者
 *   （Electron 内嵌时来自 agent 匿名会话）。提供后，本地缺少腾讯云凭证时上传识别
 *   改走可信 Edge transcribe 转发通道。
 * @param {string} [options.supabaseUrl] Edge 所在 Supabase URL（默认 config.supabaseUrl）
 * @param {string} [options.supabaseAnonKey] Supabase anon key（默认 config.supabaseAnonKey）
 * @param {object} [options.logger] 错误日志输出（默认 console）
 * @returns {Promise<{port: number, httpPort: number, close: () => Promise<void>, getEndpoints: () => Array<{host: string, port: number, httpPort: number}>}>}
 */
export async function createLanServer({
  rootDir,
  deviceId,
  config = loadConfig(),
  port,
  httpPort,
  certsDir,
  tmpDir,
  pairingTokensPath,
  getAccessToken,
  supabaseUrl,
  supabaseAnonKey,
  onPairingKnock,
  output,
  logger = console
} = {}) {
  if (!rootDir) {
    throw new Error("createLanServer requires rootDir");
  }

  let closed = false;
  let closePromise = null;
  // Edge 转发只在缺少自带腾讯凭证时启用。
  const edgeAsr = (typeof getAccessToken === "function" && (supabaseUrl ?? config.supabaseUrl))
    ? {
      getAccessToken,
      deviceId,
      supabaseUrl: supabaseUrl ?? config.supabaseUrl,
      supabaseAnonKey: supabaseAnonKey ?? config.supabaseAnonKey
    }
    : null;

  const publicDir = path.join(rootDir, "src/public");
  const uploadTmpDir = tmpDir ?? path.join(rootDir, "tmp");
  await fs.mkdir(uploadTmpDir, { recursive: true });
  sweepStaleUploads(uploadTmpDir);

  const localIps = listLocalIps();
  const localIp = localIps[0] || getLocalIp();
  const { key, cert } = await ensureCertificates(rootDir, { localIp, localIps, certsDir });

  // ---- HTTPS 主服务 ----
  const app = express();
  const tlsServer = https.createServer({ key, cert }, app);

  app.use(express.json());
  app.use(express.static(publicDir, { maxAge: "7d", etag: true }));
  app.use("/shared", express.static(path.join(rootDir, "src/shared")));
  app.get("/vendor/supabase.js", (_req, res) => {
    res.set("Cache-Control", "public, max-age=604800");
    res.sendFile(path.join(rootDir, "node_modules/@supabase/supabase-js/dist/umd/supabase.js"));
  });

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
  let resolvedPort;
  const trustOrigin = (req) => isTrustedLanOrigin(req, {
    hosts: ["localhost", "127.0.0.1", ...listLocalIps()], port: resolvedPort
  });
  app.use("/api", (req, res, next) => {
    if (closed) return res.status(503).json({ ok: false, error: "电脑输入通道已关闭。" });
    if (!trustOrigin(req)) return res.status(403).json({ ok: false, error: "不允许此网页来源访问电脑端。" });
    next();
  });
  // ---- 局域网配对门禁 ----
  // /api/health 与配对接口本身保持开放；其余 /api 路由和 WS 需要配对 token
  //（回环请求同样需要 token）。手机端在 LAN 页面输入配对码。
  // pairingTokensPath 提供时 token 落盘（滑动 TTL，续期防抖写回，close 时
  // flush），服务重启（网络切换重建 / App 更新）不再要求手机重新输码。
  const loadInitialTokens = async () => {
    if (!pairingTokensPath) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(pairingTokensPath, "utf8"));
      if ((parsed.deviceId || null) !== (deviceId || null)) return null;
      return Array.isArray(parsed?.tokens) ? parsed.tokens : null;
    } catch {
      return null; // 首次运行或文件损坏：按无历史 token 处理
    }
  };
  const initialTokens = await loadInitialTokens();
  let pairingSaveTimer = null;
  let pendingPersist = Promise.resolve();
  const persistPairingTokens = () => {
    const result = pendingPersist.then(async () => {
      if (!pairingTokensPath) return;
      await fs.writeFile(pairingTokensPath,
        `${JSON.stringify({ deviceId: deviceId || null, tokens: pairing.exportTokens() }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 });
      await fs.chmod(pairingTokensPath, 0o600);
    });
    pendingPersist = result.catch((error) => {
      logger.warn?.(`LAN pairing token persist failed: ${error?.message || error}`);
    });
    return result;
  };
  const schedulePersistPairingTokens = () => {
    if (!pairingTokensPath) return;
    if (pairingSaveTimer) return;
    pairingSaveTimer = setTimeout(() => {
      pairingSaveTimer = null;
      void persistPairingTokens().catch(() => {});
    }, 5000);
    pairingSaveTimer.unref?.();
  };
  const pairing = createLanPairing({
    ...(initialTokens ? { initialTokens } : {}),
    ...(pairingTokensPath ? { onTokensChanged: schedulePersistPairingTokens } : {})
  });
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
  app.delete("/api/lan/pair", async (req, res) => {
    if (!pairing.hasValidToken(req)) return res.status(401).json({ ok: false, error: "需要局域网配对。" });
    pairing.revokeRequestToken(req);
    tlsWsHub.revalidateClients();
    httpWsHub?.revalidateClients();
    try {
      await persistPairingTokens();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "未能保存撤销状态，请重试。" });
    }
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
  // 原生 App 从 capacitor://localhost 加载打包资源，局域网请求走这个明文
  // HTTP 端口，避免 WKWebView 拒绝桌面端的自签名 HTTPS 证书。只给 Capacitor
  // 本地 origin 开 CORS；普通浏览器访问页面仍重定向到 HTTPS，以保留录音所需
  // 的 secure context。
  const nativeOrigins = NATIVE_LAN_ORIGINS;
  redirectApp.use((req, res, next) => {
    const origin = String(req.headers.origin || "");
    if (nativeOrigins.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, x-vb-lan-token");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(nativeOrigins.has(origin) ? 204 : 403);
      return;
    }
    next();
  });
  redirectApp.get("/api/health", (_req, res) => {
    res.json({ ok: true, app: "VoiceBridge", lan: true });
  });
  redirectApp.use("/api", (req, res) => {
    // 保留原始 /api 前缀后交给同一套受 token 保护的 API 路由。
    req.url = `/api${req.url}`;
    app(req, res);
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
  resolvedPort = await listen(tlsServer, requestedPort);
  // 注意：WS hub 必须在 TLS listen 成功之后再挂载；端口冲突时提前挂载会让
  // ws 触发第二次未被捕获的 EADDRINUSE（见 createLanServer.test.js）。
  const tlsWsHub = createWebSocketHub(tlsServer, {
    authorize: (req) => pairing.isAuthorizedRequest(req),
    trustOrigin,
    ...(output ? { output } : {})
  });
  let httpWsHub = null;
  const wsHub = {
    broadcast(payload) {
      tlsWsHub.broadcast(payload);
      httpWsHub?.broadcast(payload);
    }
  };
  const uploadRouter = createUploadRouter({
    config, wsHub, tmpDir: uploadTmpDir, edgeAsr, output,
    isActive: () => !closed,
    authorize: (req) => pairing.isAuthorizedRequest(req)
  });
  app.use("/api", uploadRouter);
  let resolvedHttpPort;
  try {
    resolvedHttpPort = await listen(redirectServer, httpPort ?? resolvedPort + 1);
    // 和 TLS hub 一样，只在 listen 成功后挂载，避免 EADDRINUSE 同时被
    // WebSocketServer 转成未捕获异常。
    httpWsHub = createWebSocketHub(redirectServer, {
      authorize: (req) => pairing.isAuthorizedRequest(req),
      trustOrigin,
      ...(output ? { output } : {})
    });
  } catch (error) {
    // HTTP 端口被占用时不能留下已绑定的 TLS 服务和 WS hub —— 先关干净再抛出。
    try {
      closed = true;
      uploadRouter.close();
      await Promise.all([tlsWsHub.close(), httpWsHub?.close()]);
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
    close({ revokeTokens = false } = {}) {
      if (revokeTokens) pairing.revokeAll();
      if (closePromise) {
        if (!revokeTokens) return closePromise;
        return closePromise.then(async () => {
          if (pairingSaveTimer) clearTimeout(pairingSaveTimer);
          pairingSaveTimer = null;
          await pendingPersist;
          if (pairingTokensPath) await fs.rm(pairingTokensPath, { force: true });
          await persistPairingTokens();
        });
      }
      closed = true;
      uploadRouter.close();
      closePromise = (async () => {
        await Promise.all([tlsWsHub.close(), httpWsHub?.close()]);
        await Promise.all([closeServer(tlsServer), closeServer(redirectServer)]);
      // 网络切换等场景会 stop/start 重建服务：挂起的防抖写盘必须先落下去，
      // 否则重建后的新实例读不到刚续期过的 token。
      if (pairingSaveTimer) {
        clearTimeout(pairingSaveTimer);
        pairingSaveTimer = null;
      }
      if (revokeTokens && pairingTokensPath) {
        await pendingPersist;
        await fs.rm(pairingTokensPath, { force: true });
      }
      await persistPairingTokens();
      })();
      return closePromise;
    }
  };
}
