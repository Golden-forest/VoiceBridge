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
    const { data: profile, error: profileError } = await serviceClient
      .from("profiles")
      .select("is_admin")
      .eq("user_id", userId)
      .maybeSingle();
    if (profileError) throw profileError;
    if (profile?.is_admin === true) {
      return errorResponse("admin_protected", "管理员账号无法自行删除，请联系系统管理员。", 403);
    }

    // An already-open provider checkout can still be paid after the local
    // account is removed. Keep its owner mapping until trusted provider state
    // settles it; closing a browser or a lease timeout does not cancel payment.
    const { data: deletionState, error: checkoutError } = await serviceClient.rpc(
      "begin_account_deletion", { p_user_id: userId }
    );
    if (checkoutError) throw checkoutError;
    if (deletionState === "checkout_pending") {
      return errorResponse("checkout_pending", "尚有未确认结束的结账请求，请等待支付状态确认或联系支持后再删除。", 409);
    }
    if (deletionState === "admin_protected") {
      return errorResponse("admin_protected", "管理员账号无法自行删除，请联系系统管理员。", 403);
    }
    if (deletionState === "account_not_found") {
      return errorResponse("account_not_found", "账号信息不存在，请重新登录后再试。", 404);
    }
    if (deletionState !== "account_deleting") throw new Error("Invalid account-deletion reservation response");

    // 尝试取消外部订阅（Paddle / Stripe），避免用户删除账号后仍被扣费
    try {
      await cancelExternalSubscriptions(serviceClient, userId);
    } catch (cancelError) {
      console.warn("Account retained because subscription cancellation failed:", cancelError);
      // 取消失败发生在任何不可逆步骤之前：释放删除意图，否则用户从此永远无法再购买。
      const { error: releaseError } = await serviceClient.rpc("clear_account_deletion_request", { p_user_id: userId });
      if (releaseError) console.error("Failed to release account deletion request:", releaseError);
      return errorResponse("subscription_cancel_failed", "订阅尚未确认取消，账号和订阅记录已保留，请稍后重试。", 502);
    }

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
    return errorResponse("delete_failed", error instanceof Error ? error.message : "账号删除失败，请稍后重试。", 500);
  }
});

// Cancel every external subscription fact, including providers which are not
// currently projected into subscriptions. Keep the entire account on any
// uncertain result; a retry queries the provider and skips already-canceled
// subscriptions instead of relying on webhook timing.
async function cancelExternalSubscriptions(
  serviceClient: SupabaseClientLike,
  userId: string
) {
  const { data: facts, error: factsError } = await serviceClient
    .from("provider_subscriptions")
    .select("provider,provider_subscription_id,status")
    .eq("user_id", userId);
  if (factsError) throw factsError;
  const { data: current, error: currentError } = await serviceClient
    .from("subscriptions")
    .select("source_provider,source_subscription_id,status")
    .eq("user_id", userId)
    .maybeSingle();
  if (currentError) throw currentError;

  const subscriptions = new Map<string, { provider: string; id: string }>();
  for (const sub of facts || []) {
    if (sub.provider_subscription_id && !isTerminalSubscription(sub.provider, sub.status)) {
      subscriptions.set(`${sub.provider}:${sub.provider_subscription_id}`, {
        provider: sub.provider, id: sub.provider_subscription_id
      });
    }
  }
  if (current?.source_subscription_id && current.source_provider !== "admin"
      && !isTerminalSubscription(current.source_provider, current.status)) {
    subscriptions.set(`${current.source_provider}:${current.source_subscription_id}`, {
      provider: current.source_provider, id: current.source_subscription_id
    });
  }

  for (const { provider, id } of subscriptions.values()) {
    let url: string;
    let headers: Record<string, string>;
    if (provider === "paddle") {
      url = `${paddleApiBaseUrl(getPaddleEnvironment())}/subscriptions/${encodeURIComponent(id)}`;
      headers = { Authorization: `Bearer ${requireEnv("PADDLE_API_KEY")}`, "Content-Type": "application/json" };
    } else if (provider === "stripe") {
      url = `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`;
      headers = { Authorization: `Bearer ${requireEnv("STRIPE_SECRET_KEY")}` };
    } else {
      throw new Error(`Cannot cancel subscription provider: ${provider}`);
    }

    const existing = await readSubscription(await fetch(url, {
      headers, signal: AbortSignal.timeout(10_000)
    }), provider);
    if (isTerminalSubscription(provider, existing.status)) continue;
    const cancelable = provider === "paddle"
      ? ["active", "trialing", "past_due", "paused"]
      : ["incomplete", "trialing", "active", "past_due", "unpaid", "paused"];
    if (!cancelable.includes(existing.status || "")) throw new Error("Unknown subscription state");

    const response = await fetch(provider === "paddle" ? `${url}/cancel` : url, {
      method: provider === "paddle" ? "POST" : "DELETE",
      headers,
      ...(provider === "paddle" ? { body: JSON.stringify({ effective_from: "immediately" }) } : {}),
      signal: AbortSignal.timeout(10_000)
    });
    const canceled = await readSubscription(response, provider);
    if (canceled.status !== "canceled") throw new Error("Provider has not confirmed cancellation");
  }
}

function isTerminalSubscription(provider: string, status: unknown): boolean {
  // Stripe documents incomplete_expired as terminal: its invoice is voided
  // and it will never generate another invoice. Paused/unpaid are resumable.
  return status === "canceled" || (provider === "stripe" && status === "incomplete_expired");
}

async function readSubscription(response: Response, provider: string): Promise<{ status?: string }> {
  if (!response.ok) throw new Error(`Subscription API returned ${response.status}`);
  const body = await response.json();
  const subscription = provider === "paddle" ? body?.data : body;
  if (!subscription || typeof subscription.status !== "string") {
    throw new Error("Invalid subscription API response");
  }
  return subscription;
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function errorResponse(code: string, message: string, status: number) {
  return jsonResponse({ ok: false, code, message }, status);
}
