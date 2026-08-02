import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @deno-types="data:application/typescript,declare const Stripe: any; export default Stripe;"
import Stripe from "https://esm.sh/stripe@22.2.0?target=deno&no-dts";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  getBillingEnv,
  createPaddle,
  buildCheckoutUrl,
  type BillingEnv,
} from "../_shared/paddle.ts";

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
      return errorResponse("请先登录后再升级 Pro。", 401);
    }
    const userId = data.user.id;
    const email = data.user.email || null;

    // 查询当前权益，阻止重复购买
    const blockReason = await checkExistingEntitlement(serviceClient, userId);
    if (blockReason) {
      return errorResponse(blockReason, 409);
    }

    if (env.billingProvider === "paddle") {
      return await handlePaddleCheckout({ env, serviceClient, userId, email });
    }
    return await handleStripeCheckout({ env, serviceClient, userId, email });
  } catch (error) {
    console.error("Create checkout session error:", error);
    return errorResponse(error?.message || "创建结账链接失败，请稍后重试。", 500);
  }
});

// ============================================================================
// Paddle Checkout
// ============================================================================
async function handlePaddleCheckout({
  env,
  serviceClient,
  userId,
  email,
}: {
  env: BillingEnv;
  serviceClient: SupabaseClientLike;
  userId: string;
  email: string | null;
}) {
  // 原子领取或恢复 checkout attempt
  const { data: attemptData, error: attemptError } = await serviceClient.rpc(
    "claim_checkout_attempt",
    { p_user_id: userId, p_provider: "paddle" }
  );
  if (attemptError) throw attemptError;
  const attempt = attemptData?.[0];
  if (!attempt) {
    return errorResponse("无法创建结账会话，请稍后重试。", 500);
  }

  // 如果已有 open attempt，直接返回已有 URL
  if (attempt.status === "open" && attempt.checkout_url) {
    return jsonResponse({ ok: true, url: attempt.checkout_url });
  }
  // 如果仍在 creating（被其他并发请求持有），提示稍后重试
  if (attempt.status === "creating" && !attempt.provider_transaction_id) {
    return errorResponse("正在创建结账链接，请稍后重试。", 409);
  }

  // 当前请求是 attempt 的拥有者，调用 Paddle 创建 Transaction
  const paddle = createPaddle(env.paddleApiKey, env.paddleEnvironment);
  let transaction: any;
  try {
    transaction = await paddle.transactions.create({
      items: [{ priceId: env.paddlePriceId, quantity: 1 }],
      collectionMode: "automatic",
      customData: { user_id: userId },
    });
  } catch (err) {
    // 标记 attempt 失败
    await serviceClient.rpc("update_checkout_attempt", {
      p_id: attempt.id,
      p_status: "failed",
      p_last_error: err?.message || "Paddle transaction creation failed",
    });
    throw err;
  }

  const checkoutUrl = buildCheckoutUrl(env.paddleHostedCheckoutUrl, transaction.id);

  // 保存 Transaction ID 和 URL，标记为 open
  const { error: updateError } = await serviceClient.rpc("update_checkout_attempt", {
    p_id: attempt.id,
    p_status: "open",
    p_provider_transaction_id: transaction.id,
    p_checkout_url: checkoutUrl,
  });
  if (updateError) throw updateError;

  return jsonResponse({ ok: true, url: checkoutUrl });
}

// ============================================================================
// Stripe Checkout（迁移期保留，BILLING_PROVIDER=stripe 时走此分支）
// ============================================================================
async function handleStripeCheckout({
  env,
  serviceClient,
  userId,
  email,
}: {
  env: BillingEnv;
  serviceClient: SupabaseClientLike;
  userId: string;
  email: string | null;
}) {
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const stripePriceId = Deno.env.get("STRIPE_PRO_MONTHLY_PRICE_ID");
  const successUrl = Deno.env.get("STRIPE_SUCCESS_URL");
  const cancelUrl = Deno.env.get("STRIPE_CANCEL_URL");
  if (!stripeSecretKey || !stripePriceId || !successUrl || !cancelUrl) {
    throw new Error("Stripe 配置不完整，无法创建结账。");
  }

  const stripe = createStripe(stripeSecretKey);
  const customerId = await getOrCreateStripeCustomer({
    stripe,
    serviceClient,
    userId,
    email,
  });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: stripePriceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { user_id: userId },
    subscription_data: { metadata: { user_id: userId } },
  });

  if (!session.url) {
    return errorResponse("Stripe 未返回结账链接。", 500);
  }
  return jsonResponse({ ok: true, url: session.url });
}

// ============================================================================
// 共享辅助
// ============================================================================

/**
 * 查询当前权益。active/trialing/admin/past_due 的用户不允许购买。
 */
async function checkExistingEntitlement(
  serviceClient: SupabaseClientLike,
  userId: string
): Promise<string | null> {
  const { data, error } = await serviceClient
    .from("subscriptions")
    .select("plan,status")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.warn("checkExistingEntitlement error:", error.message);
    return null; // 查询失败时不阻塞，让 checkout 继续
  }
  if (!data) return null;

  if (data.plan === "admin") {
    return "管理员账户无需升级。";
  }
  if (["active", "trialing", "past_due"].includes(data.status) && data.plan === "pro") {
    return "你已有有效的 Pro 订阅。";
  }
  return null;
}

async function getOrCreateStripeCustomer({
  stripe,
  serviceClient,
  userId,
  email,
}: {
  stripe: any;
  serviceClient: SupabaseClientLike;
  userId: string;
  email: string | null;
}) {
  const { data: profile } = await serviceClient
    .from("profiles")
    .select("stripe_customer_id,email")
    .eq("user_id", userId)
    .maybeSingle();
  if (profile?.stripe_customer_id) {
    return profile.stripe_customer_id as string;
  }

  const customer = await stripe.customers.create({
    email: email || profile?.email || undefined,
    metadata: { user_id: userId },
  });

  await serviceClient
    .from("profiles")
    .upsert({
      user_id: userId,
      email: email || profile?.email || null,
      stripe_customer_id: customer.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

  return customer.id;
}

function createStripe(secretKey: string) {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION as any,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function errorResponse(message: string, status: number) {
  return jsonResponse({ ok: false, message }, status);
}
