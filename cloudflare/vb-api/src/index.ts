// VoiceBridge API 反代：把 vb-api.heyflint.top 的全部请求透传到 Supabase。
// 背景：*.supabase.co 在中国大陆被 SNI 阻断（2026-09 起，概率性 RST），
// 自有域名走 Cloudflare 边缘可直连。纯透传，不做任何鉴权/改写——
// apikey 与 Authorization 由客户端携带，Supabase 自行校验。
// WebSocket（Realtime）升级请求由 fetch 原样透传（101）。
const UPSTREAM = "https://gqxxknusznbunkiznnal.supabase.co";

// 腾讯 Flash ASR 直连代理：asr.cloud.tencent.com 是服务器 API，不返回 CORS 头，
// WebView/PWA 里的跨域 fetch 会被浏览器拦截（TypeError: Failed to fetch）——
// "手机直传腾讯"通道自上线以来从未在 WebView 里成功过（2026-10-11 安卓实测
// 13/13 次 tencent_error 全部回退慢速中转）。手机把签名请求发到本 Worker 同源
// 路径 /asr/flash/*，Worker 原样转发腾讯：签名 URL 的 path+query+body 不动，
// 腾讯侧看到的仍是原始签名请求，验签不受影响；响应补 CORS 头返回。
const TENCENT_FLASH_ASR = "https://asr.cloud.tencent.com";
const TENCENT_FLASH_PATH_PREFIX = "/asr/flash/";

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Asr-Seq");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith(TENCENT_FLASH_PATH_PREFIX)) {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }
      // 只转发腾讯鉴权必需的头（带 CF 内部头会被腾讯 WAF 拒——2026-10-11 实测 404）。
      const upstreamUrl = TENCENT_FLASH_ASR + url.pathname + url.search;
      const headers = new Headers();
      for (const key of ["authorization", "content-type", "content-length"]) {
        const v = request.headers.get(key);
        if (v) headers.set(key, v);
      }
      const upstreamRes = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.body
      });
      return withCors(upstreamRes);
    }

    return fetch(new Request(UPSTREAM + url.pathname + url.search, request));
  },
};
