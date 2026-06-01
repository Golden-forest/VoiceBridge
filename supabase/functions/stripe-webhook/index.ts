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
  event
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
  session
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
        updated_at: new Date().toISOString()
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
  invoice
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

async function upsertSubscription(
  serviceClient: SupabaseClientLike,
  subscription: any,
  fallbackUserId: string | null = null
) {
  const customerId = getId(subscription.customer);
  const subscriptionId = subscription.id;
  if (!customerId || !subscriptionId) {
    return;
  }

  const userId = await resolveUserId(serviceClient, {
    metadataUserId: subscription.metadata?.user_id,
    fallbackUserId,
    stripeCustomerId: customerId
  });
  if (!userId) {
    console.warn("Could not resolve subscription user:", subscriptionId);
    return;
  }

  const item = subscription.items?.data?.[0];
  const { error } = await serviceClient
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
      updated_at: new Date().toISOString()
    }, { onConflict: "stripe_subscription_id" });
  if (error) {
    throw error;
  }
}

async function resolveUserId(
  serviceClient: SupabaseClientLike,
  {
    metadataUserId,
    fallbackUserId,
    stripeCustomerId
  }: {
    metadataUserId?: string | null;
    fallbackUserId?: string | null;
    stripeCustomerId: string;
  }
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
    httpClient: Stripe.createFetchHttpClient()
  });
}

function getEnv() {
  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    stripeSecretKey: requireEnv("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: requireEnv("STRIPE_WEBHOOK_SECRET")
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
