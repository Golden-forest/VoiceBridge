import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @deno-types="data:application/typescript,declare const Stripe: any; export default Stripe;"
import Stripe from "https://esm.sh/stripe@22.2.0?target=deno&no-dts";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getBillingEnv, createPaddle } from "../_shared/paddle.ts";

const STRIPE_API_VERSION = "2026-02-25.clover";
type SupabaseClientLike = ReturnType<typeof createClient<any, "public", any>>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse("仅支持 POST 请求。", 405);
  }

  try {
    const env = getBillingEnv();
    const authHeader = req.headers.get("Authorization") || "";
    const authClient = createClient(env.supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);

    const { data, error } = await authClient.auth.getUser();
    if (error || !data.user) {
      return errorResponse("请先登录后再管理订阅。", 401);
    }
    const userId = data.user.id;

    // 查询当前权益的 source_provider 和 source_subscription_id
    const { data: sub, error: subError } = await serviceClient
      .from("subscriptions")
      .select("source_provider,source_subscription_id,plan,status")
      .eq("user_id", userId)
      .maybeSingle();
    if (subError) throw subError;
    if (!sub || !sub.source_provider) {
      return errorResponse("还没有可管理的订阅。", 404);
    }
    if (sub.plan === "admin") {
      return errorResponse("管理员账户无需管理订阅。", 400);
    }

    const sourceProvider = sub.source_provider as string;

    // 根据来源路由
    if (sourceProvider === "paddle") {
      return await handlePaddlePortal({ env, serviceClient, userId, subscriptionId: sub.source_subscription_id });
    }
    if (sourceProvider === "stripe") {
      return await handleStripePortal({ serviceClient, userId });
    }
    return errorResponse(`不支持的订阅来源：${sourceProvider}`, 400);
  } catch (error) {
    console.error("Create portal session error:", error);
    return errorResponse(error?.message || "创建订阅管理链接失败，请稍后重试。", 500);
  }
});

// ============================================================================
// Paddle Portal
// ============================================================================
async function handlePaddlePortal({
  env,
  serviceClient,
  userId,
  subscriptionId,
}: {
  env: ReturnType<typeof getBillingEnv>;
  serviceClient: SupabaseClientLike;
  userId: string;
  subscriptionId: string | null;
}) {
  // 从 billing_customers 获取该用户的 Paddle Customer ID
  const { data: customerMapping, error: customerError } = await serviceClient
    .from("billing_customers")
    .select("provider_customer_id")
    .eq("user_id", userId)
    .eq("provider", "paddle")
    .maybeSingle();
  if (customerError) throw customerError;
  if (!customerMapping?.provider_customer_id) {
    return errorResponse("未找到 Paddle 客户记录。", 404);
  }

  const paddle = createPaddle(env.paddleApiKey, env.paddleEnvironment);
  const session = await paddle.customerPortalSessions.create(
    customerMapping.provider_customer_id,
    subscriptionId ? [subscriptionId] : undefined,
  );

  const portalUrl = session?.urls?.general?.overview;
  if (!portalUrl) {
    return errorResponse("Paddle 未返回管理页面链接。", 500);
  }
  return jsonResponse({ ok: true, url: portalUrl });
}

// ============================================================================
// Stripe Portal（迁移期保留）
// ============================================================================
async function handleStripePortal({
  serviceClient,
  userId,
}: {
  serviceClient: SupabaseClientLike;
  userId: string;
}) {
  const { data: customerMapping } = await serviceClient
    .from("billing_customers")
    .select("provider_customer_id")
    .eq("user_id", userId)
    .eq("provider", "stripe")
    .maybeSingle();

  let stripeCustomerId = customerMapping?.provider_customer_id;
  if (!stripeCustomerId) {
    // 兜底：从 profiles 读
    const { data: profile } = await serviceClient
      .from("profiles")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    stripeCustomerId = profile?.stripe_customer_id;
  }
  if (!stripeCustomerId) {
    return errorResponse("还没有可管理的订阅。", 404);
  }

  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) throw new Error("STRIPE_SECRET_KEY 未配置");
  const returnUrl = Deno.env.get("STRIPE_PORTAL_RETURN_URL")
    || Deno.env.get("STRIPE_SUCCESS_URL")
    || "https://voicebridge-6kr.pages.dev/";

  const stripe = createStripe(stripeSecretKey);
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });

  return jsonResponse({ ok: true, url: session.url });
}

// ============================================================================
// 辅助
// ============================================================================
function createStripe(secretKey: string) {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION as any,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function errorResponse(message: string, status: number) {
  return jsonResponse({ ok: false, message }, status);
}
