import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getPaddleEnvironment, paddleApiBaseUrl } from "../_shared/paddle.ts";

type SupabaseClientLike = ReturnType<typeof createClient<any, "public", any>>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse("method_not_allowed", "仅支持 POST 请求。", 405);
  }

  try {
    const supabaseUrl = requireEnv("SUPABASE_URL");
    const supabaseAnonKey = requireEnv("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const authHeader = req.headers.get("Authorization") || "";
    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      }
    });
    const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey);

    const accessToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!accessToken) {
      return errorResponse("unauthorized", "请先登录后再删除账号。", 401);
    }
    const { data, error } = await authClient.auth.getClaims(accessToken);
    const subject = data?.claims?.sub;
    if (error || typeof subject !== "string" || !subject) {
      return errorResponse("unauthorized", "请先登录后再删除账号。", 401);
    }
    const userId = subject;

    // 拒绝删除管理员账号
    const { data: profile } = await serviceClient
      .from("profiles")
      .select("is_admin")
      .eq("user_id", userId)
      .maybeSingle();
    if (profile?.is_admin === true) {
      return errorResponse("admin_protected", "管理员账号无法自行删除，请联系系统管理员。", 403);
    }

    // 尝试取消外部订阅（Paddle / Stripe），避免用户删除账号后仍被扣费
    await cancelExternalSubscriptions(serviceClient, userId);

    // 删除 auth.users 记录 —— 所有业务表通过 ON DELETE CASCADE 自动清理
    // （profiles, devices, device_pairings, subscriptions, usage_events,
    //   user_commands, billing_customers, provider_subscriptions,
    //   billing_checkout_attempts; billing_events.user_id 置 NULL 保留审计）
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(userId);
    if (deleteError) {
      console.error("Failed to delete user:", deleteError);
      return errorResponse("delete_failed", "账号删除失败，请稍后重试。", 500);
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    console.error("Account deletion error:", error);
    return errorResponse("delete_failed", error?.message || "账号删除失败，请稍后重试。", 500);
  }
});

/**
 * 在删除用户之前，尝试取消其活跃的外部订阅。
 * 失败不阻塞删除流程（仅记录日志），因为：
 * 1. 用户可能已经通过支付商门户自行取消了
 * 2. webhook 会同步状态
 * 3. 删账号本身就是"终止关系"的强信号
 */
async function cancelExternalSubscriptions(
  serviceClient: SupabaseClientLike,
  userId: string
) {
  try {
    const { data: sub } = await serviceClient
      .from("subscriptions")
      .select("source_provider,source_subscription_id,status")
      .eq("user_id", userId)
      .maybeSingle();

    if (!sub || sub.status !== "active" || !sub.source_subscription_id) return;

    const provider = sub.source_provider;
    const subscriptionId = sub.source_subscription_id;

    if (provider === "paddle") {
      const paddleApiKey = Deno.env.get("PADDLE_API_KEY");
      if (!paddleApiKey) return;
      const baseUrl = paddleApiBaseUrl(getPaddleEnvironment());
      await fetch(`${baseUrl}/subscriptions/${subscriptionId}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${paddleApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ status: "canceled" })
      });
    } else if (provider === "stripe") {
      const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
      if (!stripeSecretKey) return;
      await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${stripeSecretKey}` }
      });
    }
  } catch (error) {
    // 非关键路径，仅记录
    console.warn("Failed to cancel external subscription during account deletion:", error);
  }
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function errorResponse(code: string, message: string, status: number) {
  return jsonResponse({ ok: false, code, message }, status);
}
