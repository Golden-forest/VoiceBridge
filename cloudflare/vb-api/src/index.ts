// VoiceBridge API 反代：把 vb-api.heyflint.top 的全部请求透传到 Supabase。
// 背景：*.supabase.co 在中国大陆被 SNI 阻断（2026-09 起，概率性 RST），
// 自有域名走 Cloudflare 边缘可直连。纯透传，不做任何鉴权/改写——
// apikey 与 Authorization 由客户端携带，Supabase 自行校验。
// WebSocket（Realtime）升级请求由 fetch 原样透传（101）。
const UPSTREAM = "https://gqxxknusznbunkiznnal.supabase.co";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    return fetch(new Request(UPSTREAM + url.pathname + url.search, request));
  },
};
