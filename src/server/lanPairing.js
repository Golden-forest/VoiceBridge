import crypto from "node:crypto";

// 局域网配对门禁：LAN 页面模式（手机直接访问 https://<lan-ip>:<port>）下，
// 同网段任何设备都能访问桌面端服务。历史模式靠浏览器证书告警作为唯一屏障，
// 这里补一个最小门禁：桌面端显示 6 位配对码，手机输入一次换取长期 token
//（localStorage 持久化，服务端内存保存）。回环地址（本机开发）免配对。
//
// 不引入新加密方案：配对码 = 随机数字，token = crypto.randomUUID()，仅做
// 服务端字符串比对。服务重启后 token 失效，需要重新输入配对码。

const LAN_TOKEN_HEADER = "x-vb-lan-token";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

export function createLanPairing({
  codeLength = 6,
  tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
  now = Date.now
} = {}) {
  const code = String(crypto.randomInt(0, 10 ** codeLength)).padStart(codeLength, "0");
  const tokens = new Map(); // token -> expiry ms

  return {
    /** 当前配对码（桌面端展示给用户） */
    code,

    /** 用配对码换取 token；成功返回 token，失败返回 null */
    pair(codeAttempt) {
      if (typeof codeAttempt !== "string" || codeAttempt !== code) return null;
      const token = crypto.randomUUID();
      tokens.set(token, now() + tokenTtlMs);
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
