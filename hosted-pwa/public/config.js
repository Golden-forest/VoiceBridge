window.__VB_CONFIG = {
  voicebridgeMode: "cloud",
  // 经自有域名 vb-api.heyflint.top（Cloudflare Worker 反代）访问 Supabase，
  // 规避 *.supabase.co 在中国大陆的 SNI 阻断。见 cloudflare/vb-api/。
  supabaseUrl: "https://vb-api.heyflint.top",
  supabaseAnonKey: "sb_publishable_0wcI6mr1P8mWCWZmK2d1qw_-6l2_tlc",
  // Paddle.js 客户端令牌可公开使用；服务端 API Key 绝不能放在这里。
  paddleClientToken: "live_41b31a9d8a0a8f7ca79db094438",
  // Live 构建固定使用 production，避免按 hostname 猜测环境。
  paddleEnvironment: "production"
};
