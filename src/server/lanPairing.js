import crypto from "node:crypto";

// 局域网配对门禁：LAN 页面模式（手机直接访问 https://<lan-ip>:<port>）下，
// 同网段任何设备都能访问桌面端服务。历史模式靠浏览器证书告警作为唯一屏障，
// 这里补一个最小门禁：桌面端显示 6 位配对码，手机输入一次换取长期 token
//（localStorage 持久化，服务端内存保存）。回环地址（本机开发）免配对。
//
// 不引入新加密方案：配对码 = 随机数字，token = crypto.randomUUID()，仅做
// 服务端字符串比对（brief 批准的取舍：明文比对不是常数时间，理论上可计时
// 逐位探测；6 位码 + 按 IP 指数退避 + 短 TTL 轮换已把该风险压到可忽略）。
// 服务重启后 token 失效，需要重新输入配对码。
//
// 暴力破解防护：
// - 配对码轮换：每次成功配对后立即重置，且最长 codeTtlMs（默认 10 分钟）过期重置。
// - 按 IP 指数退避：连续失败 maxFails 次后，该 IP 需等待 1s 起步、每次翻倍、
//   上限 backoffCapMs（默认 60s）才能再次尝试。成功后计数清零。状态仅存内存。

const LAN_TOKEN_HEADER = "x-vb-lan-token";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_FAILS = 5;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 60 * 1000;

export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress || "";
  return LOOPBACK_ADDRESSES.has(address);
}

function tokenFromRequest(req) {
  const header = req.headers?.[LAN_TOKEN_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  const query = req.url ? new URL(req.url, "http://invalid.local").searchParams.get("token") : "";
  return typeof query === "string" && query.length > 0 ? query : null;
}

function generateCode(codeLength) {
  return String(crypto.randomInt(0, 10 ** codeLength)).padStart(codeLength, "0");
}

export function createLanPairing({
  codeLength = 6,
  tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
  codeTtlMs = DEFAULT_CODE_TTL_MS,
  maxFails = DEFAULT_MAX_FAILS,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffCapMs = DEFAULT_BACKOFF_CAP_MS,
  now = Date.now
} = {}) {
  let code = generateCode(codeLength);
  let codeExpiresAt = now() + codeTtlMs;
  const tokens = new Map(); // token -> expiry ms
  const failsByIp = new Map(); // ip -> consecutive failed attempts
  const blockedUntilByIp = new Map(); // ip -> blocked-until ms

  const rotateCode = () => {
    code = generateCode(codeLength);
    codeExpiresAt = now() + codeTtlMs;
  };

  const ensureCodeFresh = () => {
    if (now() >= codeExpiresAt) rotateCode();
  };

  return {
    /** 当前配对码（桌面端展示给用户）；过期自动轮换 */
    get code() {
      ensureCodeFresh();
      return code;
    },

    /** 该 IP 因连续失败被限流时，返回还需等待的毫秒数；否则返回 0 */
    getRetryAfterMs(req) {
      const ip = req?.socket?.remoteAddress || "unknown";
      const blockedUntil = blockedUntilByIp.get(ip) || 0;
      const remaining = blockedUntil - now();
      if (remaining > 0) return remaining;
      if (blockedUntil) blockedUntilByIp.delete(ip);
      return 0;
    },

    /**
     * 用配对码换取 token；成功返回 token，失败或被限流返回 null。
     * 成功后配对码立即轮换（一次性），并清空该 IP 的失败计数。
     */
    pair(codeAttempt, req) {
      if (this.getRetryAfterMs(req) > 0) return null;
      ensureCodeFresh();
      const ip = req?.socket?.remoteAddress || "unknown";
      if (typeof codeAttempt !== "string" || codeAttempt !== code) {
        const fails = (failsByIp.get(ip) || 0) + 1;
        failsByIp.set(ip, fails);
        if (fails >= maxFails) {
          const backoff = Math.min(backoffBaseMs * 2 ** (fails - maxFails), backoffCapMs);
          blockedUntilByIp.set(ip, now() + backoff);
        }
        return null;
      }
      failsByIp.delete(ip);
      blockedUntilByIp.delete(ip);
      const token = crypto.randomUUID();
      tokens.set(token, now() + tokenTtlMs);
      rotateCode(); // 一次性配对码：用后即换
      return token;
    },

    isValidToken(token) {
      if (typeof token !== "string" || !tokens.has(token)) return false;
      if (tokens.get(token) <= now()) {
        tokens.delete(token);
        return false;
      }
      return true;
    },

    /** 请求是否已通过门禁（本机免配对；否则校验 token） */
    isAuthorizedRequest(req) {
      if (isLoopbackRequest(req)) return true;
      return this.isValidToken(tokenFromRequest(req));
    },

    /** Express 中间件：拦截未配对的 LAN 请求 */
    createMiddleware() {
      return (req, res, next) => {
        if (this.isAuthorizedRequest(req)) {
          next();
          return;
        }
        res.status(401).json({ ok: false, error: "需要局域网配对，请在手机端输入配对码。" });
      };
    }
  };
}

export const LAN_TOKEN_HEADER_NAME = LAN_TOKEN_HEADER;
