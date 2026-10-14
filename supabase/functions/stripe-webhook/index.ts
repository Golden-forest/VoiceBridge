// Stripe Webhook（迁移期双写）
//
// 保留 stripe_events 完成标记；权益由 process_billing_event 原子投影和去重，
// 成功后补齐 subscriptions 的旧 stripe_* 兼容字段。
// （billing_customers / provider_subscriptions / billing_events）。
// 这样 Paddle 上线后，Stripe 的存量用户在新表中也有记录，
// Portal 路由和权益投影可以统一工作。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @deno-types="data:application/typescript,declare const Stripe: any; export default Stripe;"
import Stripe from "https://esm.sh/stripe@22.2.0?target=deno&no-dts";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const STRIPE_API_VERSION = "2026-02-25.clover";
type SupabaseClientLike = ReturnType<typeof createClient<any, "public", any>>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse("仅支持 POST 请求。", 405);
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return errorResponse("缺少 Stripe 签名。", 400);
  }

  try {
    const env = getEnv();
    const stripe = createStripe(env.stripeSecretKey);
    const body = await req.text();
    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      env.stripeWebhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider()
    );
    const serviceClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);

    // A legacy marker may have been inserted by an older worker before it
    // crashed. It cannot prove success. The atomic billing RPC handles locks,
    // duplicates and failed retries before any HTTP acknowledgment.
    await processStripeEvent({ stripe, serviceClient, event });
    await insertStripeEvent(serviceClient, event);
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return errorResponse("Stripe webhook 处理失败。", 500);
  }
});

async function insertStripeEvent(serviceClient: SupabaseClientLike, event: any) {
  const { error } = await serviceClient
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });
  if (error && error.code !== "23505") throw error;
}

async function processStripeEvent({
  stripe,
  serviceClient,
  event,
}: {
  stripe: any;
  serviceClient: SupabaseClientLike;
  event: any;
}) {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutSessionCompleted({ stripe, serviceClient, session: event.data.object, event });
      await settleCheckoutAttempt(serviceClient, event.data.object.id, "completed");
      break;
    case "checkout.session.expired":
      await settleCheckoutAttempt(serviceClient, event.data.object.id, "expired");
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await upsertSubscription(serviceClient, event.data.object, event);
      break;
    case "invoice.paid":
    case "invoice.payment_failed":
      await handleInvoiceEvent({ stripe, serviceClient, invoice: event.data.object, event });
      break;
    default:
      break;
  }
}

async function handleCheckoutSessionCompleted({
  stripe,
  serviceClient,
  session,
  event,
}: {
  stripe: any;
  serviceClient: SupabaseClientLike;
  session: any;
  event: any;
}) {
  const userId = session.metadata?.user_id;
  const customerId = getId(session.customer);
  if (userId && customerId) {
    const { error } = await serviceClient
      .from("profiles")
      .upsert({
        user_id: userId,
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    if (error) {
      throw error;
    }
  }

  const subscriptionId = getId(session.subscription);
  if (subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    await upsertSubscription(serviceClient, subscription, event, userId || null);
  }
}

async function handleInvoiceEvent({
  stripe,
  serviceClient,
  invoice,
  event,
}: {
  stripe: any;
  serviceClient: SupabaseClientLike;
  invoice: any;
  event: any;
}) {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return;
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await upsertSubscription(serviceClient, subscription, event);
}

async function settleCheckoutAttempt(serviceClient: SupabaseClientLike, sessionId: string, status: "completed" | "expired") {
  const { error } = await serviceClient.from("billing_checkout_attempts")
    .update({ status, updated_at: new Date().toISOString(), last_error: null })
    .eq("provider", "stripe").eq("provider_transaction_id", sessionId)
    .in("status", ["creating", "open"]);
  if (error) throw error;
}

// 旧逻辑：写入 subscriptions 表（保留 stripe_* 列兼容）
// 新逻辑：同时通过 RPC 双写到 billing_customers / provider_subscriptions
async function upsertSubscription(
  serviceClient: SupabaseClientLike,
  subscription: any,
  event: any,
  fallbackUserId: string | null = null,
) {
  const customerId = getId(subscription.customer);
  const subscriptionId = subscription.id;
  if (!customerId || !subscriptionId) {
    return;
  }

  const userId = await resolveUserId(serviceClient, {
    metadataUserId: subscription.metadata?.user_id,
    fallbackUserId,
    stripeCustomerId: customerId,
  });
  if (!userId) {
    console.warn("Could not resolve subscription user:", subscriptionId);
    return;
  }

  const item = subscription.items?.data?.[0];

  // The signed event ID distinguishes renewals and same-status changes; a
  // subscription/status-derived key would drop all subsequent active events.
  const effect = {
    type: "subscription",
    user_id: userId,
    customer_id: customerId,
    subscription_id: subscriptionId,
    price_id: item?.price?.id || null,
    plan: "pro",
    status: subscription.status,
    period_start: toIsoTime((subscription as any).current_period_start) || "",
    period_end: toIsoTime((subscription as any).current_period_end) || "",
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    state_occurred_at: toIsoTime(event.created),
  };
  const { data: action, error: rpcError } = await serviceClient.rpc("process_billing_event", {
    p_provider: "stripe",
    p_event_id: event.id,
    p_event_type: event.type,
    p_occurred_at: toIsoTime(event.created),
    p_payload: { source: "stripe_webhook_double_write", subscription },
    p_effect: effect,
  });
  if (rpcError) throw rpcError;
  if (!["processed", "duplicate", "stale"].includes(action)) {
    throw new Error("Billing event processing failed; retry required");
  }
  if (action === "stale") return;

  // Preserve legacy provider fields without overwriting the RPC's entitlement
  // projection (including admin or a currently active Paddle subscription).
  const { error: legacyError } = await serviceClient.from("subscriptions")
    .update({
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      stripe_price_id: item?.price?.id || null,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
  if (legacyError) throw legacyError;
}

async function resolveUserId(
  serviceClient: SupabaseClientLike,
  {
    metadataUserId,
    fallbackUserId,
    stripeCustomerId,
  }: {
    metadataUserId?: string | null;
    fallbackUserId?: string | null;
    stripeCustomerId: string;
  },
) {
  if (metadataUserId) {
    return metadataUserId;
  }
  if (fallbackUserId) {
    return fallbackUserId;
  }

  const { data, error } = await serviceClient
    .from("profiles")
    .select("user_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data?.user_id || null;
}

function getInvoiceSubscriptionId(invoice: any) {
  const value = (invoice as any).subscription
    || (invoice as any).parent?.subscription_details?.subscription
    || (invoice as any).lines?.data?.find((line: any) => line.subscription)?.subscription;
  return getId(value);
}

function getId(value: string | { id?: string } | null | undefined) {
  if (typeof value === "string") {
    return value;
  }
  return value?.id || null;
}

function toIsoTime(timestamp: number | null | undefined) {
  return typeof timestamp === "number" ? new Date(timestamp * 1000).toISOString() : null;
}

function createStripe(secretKey: string) {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION as any,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function getEnv() {
  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    stripeSecretKey: requireEnv("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: requireEnv("STRIPE_WEBHOOK_SECRET"),
  };
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function errorResponse(message: string, status: number) {
  return jsonResponse({ ok: false, message }, status);
}
