// LAN 页面模式（工作包 B 手机端）：
// - 云端页面：只要 presence 上报了 lanEndpoints（桌面自称在局域网）就展示
//   "局域网可用"切换入口；明文 HTTP 探测仅作增强（成功时优先选可达端点），
//   失败不作为隐藏依据 —— https 云端页面 fetch http://<lan-ip> 属 mixed
//   content，在真实手机浏览器上必然被拦截，探测失败 ≠ 桌面不可达。
//   端点失效时用户点击跳转会看到导航失败并返回，可接受。
// - LAN 页面：配对门禁、token 注入、失联后回退云端
// 纯逻辑与可注入依赖（fetch / timers / storage）分离，便于 node --test 测试。

export const LAN_TOKEN_STORAGE_KEY = "voicebridge_lan_token";
export const CLOUD_ORIGIN_STORAGE_KEY = "voicebridge_cloud_origin";
// 原生 App 最近一次成功直连的桌面端点：冷启动（iOS 杀后台后重开）时据此
// 自动恢复 LAN 模式，用户不需要每次手动点"局域网"入口。
export const NATIVE_LAN_ENDPOINT_STORAGE_KEY = "voicebridge_native_lan_endpoint";
export const LAN_TOKEN_HEADER = "x-vb-lan-token";
export const PROBE_TIMEOUT_MS = 500;
export const PROBE_CACHE_TTL_MS = 30_000;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(String(hostname || "").toLowerCase());
}

/**
 * 是否运行在 LAN 页面环境：非云端模式且非本机回环地址
 *（本地开发 localhost 也走 LAN 流程，但不触发配对/回退）。
 */
export function isLanPageEnvironment({ mode, hostname }) {
  return mode !== "cloud" && !isLoopbackHostname(hostname);
}

/** 过滤 presence 上报的 lanEndpoints，只保留结构完整的条目 */
export function normalizeEndpoints(endpoints) {
  if (!Array.isArray(endpoints)) return [];
  return endpoints.filter((endpoint) =>
    typeof endpoint?.host === "string" && endpoint.host.length > 0 &&
    Number.isInteger(endpoint.port) && endpoint.port > 0 &&
    Number.isInteger(endpoint.httpPort) && endpoint.httpPort > 0
  );
}

/** URL host 部分：IPv6 字面量必须加方括号 */
export function formatLanHost(host) {
  const value = String(host || "");
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

/** 探测单个端点：任何 HTTP 响应（200 / 301）都证明桌面端可达 */
export async function probeEndpoint(endpoint, { fetchImpl, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await doFetch(`http://${formatLanHost(endpoint.host)}:${endpoint.httpPort}/api/health`, {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 并行探测所有端点，按输入顺序返回第一个可达端点；全部失败返回 null */
export async function probeLanEndpoints(endpoints, options = {}) {
  const valid = normalizeEndpoints(endpoints);
  if (!valid.length) return null;
  const results = await Promise.all(valid.map((endpoint) => probeEndpoint(endpoint, options)));
  const index = results.findIndex(Boolean);
  return index === -1 ? null : valid[index];
}

/**
 * 探测缓存：结果（含失败）缓存 cacheTtlMs；online/offline 事件或端点变化时失效重探。
 * 云端页面上所有探测失败都必须静默 —— 不抛错、不弹提示。
 */
export class LanProbe {
  constructor({ fetchImpl, timeoutMs = PROBE_TIMEOUT_MS, cacheTtlMs = PROBE_CACHE_TTL_MS, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.endpoints = [];
    this.cachedResult = null;
    this.hasCache = false;
    this.cachedAt = 0;
    this.inflight = null;
  }

  setEndpoints(endpoints) {
    const next = normalizeEndpoints(endpoints);
    const same = next.length === this.endpoints.length &&
      next.every((endpoint, i) =>
        endpoint.host === this.endpoints[i].host &&
        endpoint.port === this.endpoints[i].port &&
        endpoint.httpPort === this.endpoints[i].httpPort);
    if (!same) this.invalidate();
    this.endpoints = next;
  }

  invalidate() {
    this.cachedResult = null;
    this.hasCache = false;
    this.cachedAt = 0;
  }

  getReachable() {
    if (this.hasCache && this.now() - this.cachedAt < this.cacheTtlMs) {
      return Promise.resolve(this.cachedResult);
    }
    if (this.inflight) return this.inflight;
    this.inflight = probeLanEndpoints(this.endpoints, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs
    }).then((endpoint) => {
      this.cachedResult = endpoint;
      this.hasCache = true;
      this.cachedAt = this.now();
      return endpoint;
    }).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * 切换目标端点：探测成功 → 首个可达端点（增强）；
   * 探测全部失败 → 仍返回第一个已上报端点（mixed content 下探测必然失败，
   * 不能据此隐藏入口；端点真失效时由用户点击后的导航失败兜底）；
   * 无任何上报端点 → null。
   */
  async getSwitchTarget() {
    const reachable = await this.getReachable().catch(() => null);
    return reachable || this.endpoints[0] || null;
  }

  /** 网络切换（wifi 变化）后重新探测；返回解绑函数 */
  bindWindow(win = window) {
    const handler = () => this.invalidate();
    win.addEventListener("online", handler);
    win.addEventListener("offline", handler);
    return () => {
      win.removeEventListener("online", handler);
      win.removeEventListener("offline", handler);
    };
  }
}

/** 只接受 https 来源作为云端回退地址，防止开放重定向 */
export function sanitizeCloudOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 解析并持久化云端来源：云端页面跳转到 LAN 时通过 ?cloud=<origin> 携带
 *（localStorage 按 origin 隔离，不能跨域读取），LAN 页面存入自己的
 * localStorage 供后续直访 / 失联回退使用。
 */
export function resolveCloudOrigin(win = window) {
  const fromQuery = sanitizeCloudOrigin(new URLSearchParams(win.location.search).get("cloud"));
  if (fromQuery) {
    try {
      win.localStorage.setItem(CLOUD_ORIGIN_STORAGE_KEY, fromQuery);
    } catch { /* localStorage 不可用时静默 */ }
    return fromQuery;
  }
  try {
    return sanitizeCloudOrigin(win.localStorage.getItem(CLOUD_ORIGIN_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 云端 → LAN 的跳转地址（携带云端来源参数） */
export function buildLanUrl(endpoint, cloudOrigin) {
  const origin = sanitizeCloudOrigin(cloudOrigin);
  const base = `https://${formatLanHost(endpoint.host)}:${endpoint.port}/`;
  return origin ? `${base}?cloud=${encodeURIComponent(origin)}` : base;
}

/** 原生 App 保持本地安全页面不跳转，只把 API/WS 指向桌面 HTTP 端口。 */
export function buildNativeLanBaseUrl(endpoint) {
  return `http://${formatLanHost(endpoint.host)}:${endpoint.httpPort}`;
}

/** 记住最近一次成功直连的桌面端点（原生 App 冷启动自动恢复用） */
export function rememberNativeLanEndpoint(endpoint, storage) {
  try {
    storage?.setItem(
      NATIVE_LAN_ENDPOINT_STORAGE_KEY,
      JSON.stringify({ host: endpoint?.host, port: endpoint?.port, httpPort: endpoint?.httpPort })
    );
  } catch { /* storage 不可用时静默：下次冷启动回云端模式 */ }
}

/** 读出记住的端点；结构不完整（旧版本数据/损坏）返回 null */
export function getStoredNativeLanEndpoint(storage) {
  try {
    const raw = storage?.getItem(NATIVE_LAN_ENDPOINT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const [endpoint] = normalizeEndpoints([parsed]);
    return endpoint || null;
  } catch {
    return null;
  }
}

/** 用户手动切回云端时清除：冷启动不再自动进 LAN（用户意图优先） */
export function forgetNativeLanEndpoint(storage) {
  try {
    storage?.removeItem(NATIVE_LAN_ENDPOINT_STORAGE_KEY);
  } catch { /* ignore */ }
}

/**
 * 在桌面端上报的端点列表里找到记忆端点对应的当前端点：
 * 精确匹配（host+port+httpPort）优先；HTTPS 端口漂移（桌面端重启随机分配）
 * 时回退 host+httpPort 匹配。找不到返回 null（桌面离线 / 换了网络）。
 */
export function findMatchingLanEndpoint(stored, endpoints) {
  const valid = normalizeEndpoints(endpoints);
  if (!stored) return null;
  const exact = valid.find((endpoint) =>
    endpoint.host === stored.host &&
    endpoint.port === stored.port &&
    endpoint.httpPort === stored.httpPort);
  if (exact) return exact;
  return valid.find((endpoint) =>
    endpoint.host === stored.host &&
    endpoint.httpPort === stored.httpPort) || null;
}

/** LAN token 请求头（未配对时为空对象） */
export function lanTokenHeaders(win = window) {
  try {
    const token = win.localStorage.getItem(LAN_TOKEN_STORAGE_KEY);
    return token ? { [LAN_TOKEN_HEADER]: token } : {};
  } catch {
    return {};
  }
}

/** 带 token 的 WS 地址（token 走 query，浏览器 WS API 不支持自定义头） */
export function buildLanWsUrl(win = window, endpoint = null) {
  if (endpoint) {
    let token = "";
    try {
      token = win.localStorage.getItem(LAN_TOKEN_STORAGE_KEY) || "";
    } catch { /* ignore */ }
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    return `ws://${formatLanHost(endpoint.host)}:${endpoint.httpPort}/ws${query}`;
  }
  const protocol = win.location.protocol === "https:" ? "wss" : "ws";
  let token = "";
  try {
    token = win.localStorage.getItem(LAN_TOKEN_STORAGE_KEY) || "";
  } catch { /* ignore */ }
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${protocol}://${win.location.host}/ws${query}`;
}

/** LAN 配对客户端：GET 查询状态 / POST 配对码换 token（成功后持久化） */
export function createPairingClient({ fetchImpl, storage, pairUrl = "/api/lan/pair", win } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const getStorage = () => storage || win?.localStorage;
  const headers = () => ({ ...lanTokenHeaders(win || { localStorage: storage }), "Content-Type": "application/json" });
  return {
    async status() {
      const response = await doFetch(pairUrl, { headers: headers(), cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      return { paired: response.ok && payload.ok === true && payload.paired === true };
    },
    async pair(code) {
      const response = await doFetch(pairUrl, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ code })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true || typeof payload.token !== "string") {
        return { ok: false };
      }
      try {
        getStorage()?.setItem(LAN_TOKEN_STORAGE_KEY, payload.token);
      } catch { /* ignore */ }
      return { ok: true, token: payload.token };
    }
  };
}

/**
 * LAN 页面失联回退：轮询同源 /api/health，连续失败达到阈值后触发一次
 * onFallback（由调用方决定是否跳回云端）。
 */
export class LanHealthWatch {
  constructor({ fetchImpl, healthUrl = "/api/health", intervalMs = 5000, failureThreshold = 2, onFallback, setTimeoutImpl, clearTimeoutImpl } = {}) {
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.healthUrl = healthUrl;
    this.intervalMs = intervalMs;
    this.failureThreshold = failureThreshold;
    this.onFallback = onFallback;
    this.setTimeout = setTimeoutImpl || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeout = clearTimeoutImpl || ((id) => clearTimeout(id));
    this.timer = null;
    this.failures = 0;
    this.triggered = false;
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.poll();
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async poll() {
    if (this.stopped) return;
    try {
      await this.fetchImpl(this.healthUrl, { cache: "no-store" });
      this.failures = 0;
    } catch {
      this.failures++;
      if (this.failures >= this.failureThreshold && !this.triggered) {
        this.triggered = true;
        this.stop();
        try {
          this.onFallback?.();
        } catch { /* ignore */ }
        return;
      }
    }
    if (!this.stopped) {
      this.timer = this.setTimeout(() => this.poll(), this.intervalMs);
    }
  }
}
