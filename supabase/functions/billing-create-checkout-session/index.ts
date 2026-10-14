import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @deno-types="data:application/typescript,declare const Stripe: any; export default Stripe;"
import Stripe from "https://esm.sh/stripe@22.2.0?target=deno&no-dts";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  getBillingEnv,
  createPaddle,
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
    return errorResponse(error instanceof Error ? error.message : "创建结账链接失败，请稍后重试。", 500);
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
  // PostgREST may return a single object (OUT params) or an array (RETURNS TABLE)
  const attempt = Array.isArray(attemptData) ? attemptData[0] : attemptData;
  if (!attempt) {
    return errorResponse("无法创建结账会话，请稍后重试。", 500);
  }

  // 如果已有 open attempt，直接返回已有 transactionId + URL
  if (attempt.status === "open" && attempt.provider === "paddle" && attempt.checkout_url) {
    return jsonResponse({
      ok: true,
      transactionId: attempt.provider_transaction_id || undefined,
      url: attempt.checkout_url,
    });
  }
  if (attempt.status === "entitlement_exists") {
    return errorResponse("你已有有效订阅，无需再次购买。", 409);
  }
  if (attempt.status === "account_deleting") {
    return errorResponse("账号删除正在处理，请完成删除或联系支持。", 409);
  }
  if (attempt.status === "subscription_pending") {
    return errorResponse("支付已收到，正在确认订阅权益，请稍后查看。", 409);
  }
  if (!attempt.acquired || !attempt.lease_token) {
    return errorResponse("结账请求正在处理，请稍后重试。", 409);
  }

  const { data: started, error: startError } = await serviceClient.rpc("start_checkout_provider_request", {
    p_id: attempt.id,
    p_lease_token: attempt.lease_token
  });
  if (startError) throw startError;
  if (started !== true) return errorResponse("结账请求正在处理，请稍后重试。", 409);

  // 当前请求是 attempt 的拥有者，调用 Paddle 创建 Transaction
  const paddle = createPaddle(env.paddleApiKey, env.paddleEnvironment);
  let transaction: any;
  try {
    transaction = await paddle.transactions.create({
      items: [{ priceId: env.paddlePriceId, quantity: 1 }],
      collectionMode: "automatic",
      customData: { user_id: userId, checkout_attempt_id: attempt.id },
      checkout: { url: new URL(env.paddleSuccessUrl).origin },
    });
  } catch (err) {
    // A timeout/5xx may happen after Paddle created a payable transaction.
    // Keep that attempt busy until reconciled. Only a definite API rejection
    // permits another creation; lease expiration alone must not recreate it.
    // SDK 3.8 exposes type/code rather than an HTTP status. Only known
    // validation/not-found rejections prove that no transaction was created.
    const apiError = err as { type?: string; code?: string } | null;
    const definitelyRejected = apiError?.type === "request_error"
      && ["invalid_field", "not_found"].includes(apiError.code || "");
    await serviceClient.rpc("update_checkout_attempt", {
      p_id: attempt.id,
      p_lease_token: attempt.lease_token,
      p_status: definitelyRejected ? "failed" : "creating",
      p_last_error: err instanceof Error ? err.message : "Paddle transaction creation failed",
    });
    throw err;
  }

  const checkoutUrl = transaction?.checkout?.url;
  const transactionId = transaction?.id;
  if (!checkoutUrl || !transactionId) {
    await serviceClient.rpc("update_checkout_attempt", {
      p_id: attempt.id,
      p_lease_token: attempt.lease_token,
      p_status: "creating",
      p_provider_transaction_id: transactionId || null,
      p_last_error: "Paddle transaction did not return checkout URL",
    });
    return errorResponse("创建结账链接失败：Paddle 未返回 checkout URL。", 500);
  }

  // 保存 Transaction ID 和 URL，标记为 open
  const { data: updated, error: updateError } = await serviceClient.rpc("update_checkout_attempt", {
    p_id: attempt.id,
    p_lease_token: attempt.lease_token,
    p_status: "open",
    p_provider_transaction_id: transactionId,
    p_checkout_url: checkoutUrl,
  });
  if (updateError) throw updateError;
  if (updated !== true) throw new Error("Checkout ownership changed before completion");

  // 返回 transactionId 让前端用 Paddle.js overlay 打开 checkout
  return jsonResponse({ ok: true, transactionId, url: checkoutUrl });
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

  // The migration-period provider must use the same per-user lease as Paddle.
  // Otherwise concurrent upgrade clicks still create independently payable
  // sessions (and bypass the cross-provider duplicate-purchase guard).
  const { data: attemptData, error: attemptError } = await serviceClient.rpc(
    "claim_checkout_attempt", { p_user_id: userId, p_provider: "stripe" }
  );
  if (attemptError) throw attemptError;
  const attempt = Array.isArray(attemptData) ? attemptData[0] : attemptData;
  if (attempt?.status === "open" && attempt.provider === "stripe" && attempt.checkout_url) {
    return jsonResponse({ ok: true, url: attempt.checkout_url });
  }
  if (attempt?.status === "entitlement_exists") {
    return errorResponse("你已有有效订阅，无需再次购买。", 409);
  }
  if (attempt?.status === "account_deleting") {
    return errorResponse("账号删除正在处理，请完成删除或联系支持。", 409);
  }
  if (attempt?.status === "subscription_pending") {
    return errorResponse("支付已收到，正在确认订阅权益，请稍后查看。", 409);
  }
  if (!attempt?.acquired || !attempt.lease_token) {
    return errorResponse("结账请求正在处理，请稍后重试。", 409);
  }

  const stripe = createStripe(stripeSecretKey);
  const customerId = await getOrCreateStripeCustomer({
    stripe,
    serviceClient,
    userId,
    email,
    attemptId: attempt.id,
  });

  const { data: started, error: startError } = await serviceClient.rpc("start_checkout_provider_request", {
    p_id: attempt.id, p_lease_token: attempt.lease_token
  });
  if (startError) throw startError;
  if (started !== true) return errorResponse("结账请求正在处理，请稍后重试。", 409);

  let session: any;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { user_id: userId, checkout_attempt_id: attempt.id },
      subscription_data: { metadata: { user_id: userId } },
    }, { idempotencyKey: `voicebridge-checkout:${attempt.id}` });
  } catch (err) {
    // Stripe may discard idempotency keys after 24 hours. Retain ambiguous
    // attempts rather than issuing a new payable session after that window.
    const apiError = err as { type?: string; statusCode?: number } | null;
    const definitelyRejected = apiError?.type === "StripeInvalidRequestError"
      && [400, 404].includes(apiError.statusCode || 0);
    await serviceClient.rpc("update_checkout_attempt", {
      p_id: attempt.id, p_lease_token: attempt.lease_token,
      p_status: definitelyRejected ? "failed" : "creating",
      p_last_error: err instanceof Error ? err.message : "Stripe session creation failed",
    });
    throw err;
  }

  if (!session?.id || !session?.url) {
    await serviceClient.rpc("update_checkout_attempt", {
      p_id: attempt.id, p_lease_token: attempt.lease_token,
      p_status: "creating", p_provider_transaction_id: session?.id || null,
      p_last_error: "Stripe session did not return checkout URL",
    });
    return errorResponse("Stripe 未返回结账链接。", 500);
  }

  const { data: updated, error: updateError } = await serviceClient.rpc("update_checkout_attempt", {
    p_id: attempt.id, p_lease_token: attempt.lease_token, p_status: "open",
    p_provider_transaction_id: session.id, p_checkout_url: session.url,
  });
  if (updateError) throw updateError;
  if (updated !== true) throw new Error("Checkout ownership changed before completion");
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
    throw error;
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
  attemptId,
}: {
  stripe: any;
  serviceClient: SupabaseClientLike;
  userId: string;
  email: string | null;
  attemptId: string;
}) {
  const { data: profile, error: profileError } = await serviceClient
    .from("profiles")
    .select("stripe_customer_id,email")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileError) throw profileError;
  if (profile?.stripe_customer_id) {
    return profile.stripe_customer_id as string;
  }

  const customer = await stripe.customers.create({
    email: email || profile?.email || undefined,
    metadata: { user_id: userId },
  }, { idempotencyKey: `voicebridge-customer:${attemptId}` });

  const { error: saveError } = await serviceClient
    .from("profiles")
    .upsert({
      user_id: userId,
      email: email || profile?.email || null,
      stripe_customer_id: customer.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  if (saveError) throw saveError;

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
