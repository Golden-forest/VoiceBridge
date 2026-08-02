// Stripe Webhook（迁移期双写）
//
// 保留原有 stripe_events 幂等逻辑和 subscriptions 写入不变，
// 额外把同样的事实通过 process_billing_event RPC 写入新的支付商无关表
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

  const eventIdRef = { id: "" };
  let serviceClient: SupabaseClientLike | null = null;
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
    eventIdRef.id = event.id;
    serviceClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);

    // 旧幂等表（保留）
    const inserted = await insertStripeEvent(serviceClient, event);
    if (!inserted) {
      return jsonResponse({ ok: true, duplicate: true });
    }

    await processStripeEvent({ stripe, serviceClient, event });
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    if (eventIdRef.id && serviceClient) {
      await serviceClient.from("stripe_events").delete().eq("id", eventIdRef.id);
    }
    return errorResponse("Stripe webhook 处理失败。", 500);
  }
});

async function insertStripeEvent(serviceClient: SupabaseClientLike, event: any) {
  const { error } = await serviceClient
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });
  if (!error) {
    return true;
  }
  if (error.code === "23505") {
    return false;
  }
  throw error;
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
      await handleCheckoutSessionCompleted({ stripe, serviceClient, session: event.data.object });
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await upsertSubscription(serviceClient, event.data.object);
      break;
    case "invoice.paid":
    case "invoice.payment_failed":
      await handleInvoiceEvent({ stripe, serviceClient, invoice: event.data.object });
      break;
    default:
      break;
  }
}

async function handleCheckoutSessionCompleted({
  stripe,
  serviceClient,
  session,
}: {
  stripe: any;
  serviceClient: SupabaseClientLike;
  session: any;
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
    await upsertSubscription(serviceClient, subscription, userId || null);
  }
}

async function handleInvoiceEvent({
  stripe,
  serviceClient,
  invoice,
}: {
  stripe: any;
  serviceClient: SupabaseClientLike;
  invoice: any;
}) {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return;
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await upsertSubscription(serviceClient, subscription);
}

// 旧逻辑：写入 subscriptions 表（保留 stripe_* 列兼容）
// 新逻辑：同时通过 RPC 双写到 billing_customers / provider_subscriptions
async function upsertSubscription(
  serviceClient: SupabaseClientLike,
  subscription: any,
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

  // 1. 旧表写入（保留兼容）
  const { error: legacyError } = await serviceClient
    .from("subscriptions")
    .upsert({
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      stripe_price_id: item?.price?.id || null,
      plan: "pro",
      status: subscription.status,
      current_period_start: toIsoTime((subscription as any).current_period_start),
      current_period_end: toIsoTime((subscription as any).current_period_end),
      cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      updated_at: new Date().toISOString(),
    }, { onConflict: "stripe_subscription_id" });
  if (legacyError) {
    throw legacyError;
  }

  // 2. 新表双写（通过原子 RPC）
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
    state_occurred_at: toIsoTime((subscription as any).current_period_start) || new Date().toISOString(),
  };
  const { error: rpcError } = await serviceClient.rpc("process_billing_event", {
    p_provider: "stripe",
    p_event_id: `stripe_${event_id_for_sub(subscriptionId, subscription.status)}`,
    p_event_type: `customer.subscription.updated`,
    p_occurred_at: new Date().toISOString(),
    p_payload: { source: "stripe_webhook_double_write", subscription },
    p_effect: effect,
  });
  if (rpcError) {
    console.warn("Double-write to billing_events failed:", rpcError.message);
    // 双写失败不阻塞旧逻辑，只记日志
  }
}

// 为 Stripe 双写生成稳定 event_id（同 subscription + status 只写一次）
function event_id_for_sub(subscriptionId: string, status: string): string {
  return `${subscriptionId}_${status}`;
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
