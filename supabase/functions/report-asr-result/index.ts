import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";
import { createReportAsrHandler, type DirectAsrEnv } from "../_shared/direct_asr.ts";
import type { DirectAsrServiceClient } from "../_shared/direct_asr.ts";
import { verifySupabaseJwt } from "../_shared/local_jwt.ts";

// 模块级复用：客户端创建一次，跨请求共享连接，避免每次请求重建的冷启动开销。
let cachedServiceClient: DirectAsrServiceClient | null = null;
declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

Deno.serve(async (req) => {
  return createReportAsrHandler({
    loadEnv: () => ({
      supabaseUrl: requireEnv("SUPABASE_URL"),
      supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
      supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      jwksJson: Deno.env.get("SUPABASE_JWKS") || null,
      tencent: {
        secretId: Deno.env.get("TENCENT_SECRET_ID") || "",
        secretKey: Deno.env.get("TENCENT_SECRET_KEY") || "",
        appId: Deno.env.get("TENCENT_APP_ID") || undefined,
        region: Deno.env.get("TENCENT_ASR_REGION") || "ap-shanghai",
        engServiceType: Deno.env.get("TENCENT_ASR_ENG_SERVICE_TYPE") || "16k_zh"
      }
    }),
    createServiceClient: () => cachedServiceClient ??= createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    ) as unknown as DirectAsrServiceClient,
    authenticate,
    waitUntil: (promise) => EdgeRuntime.waitUntil(promise)
  })(req).then((response) => withCors(response));
});

// 本地验签（与 transcribe 相同模式）：SUPABASE_JWKS 优先，失败回退 getClaims。
async function authenticate(authHeader: string, env: DirectAsrEnv): Promise<string | null> {
  const accessToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!accessToken) return null;
  const issuer = `${env.supabaseUrl}/auth/v1`;
  if (env.jwksJson) {
    const claims = await verifySupabaseJwt(accessToken, { jwksJson: env.jwksJson, issuer }).catch(() => null);
    if (claims?.sub) return claims.sub;
  }
  const authClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });
  const { data, error } = await authClient.auth.getClaims(accessToken);
  const subject = data?.claims?.sub;
  if (error || typeof subject !== "string" || !subject) return null;
  return subject;
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
