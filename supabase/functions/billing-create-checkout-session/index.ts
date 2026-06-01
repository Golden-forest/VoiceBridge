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

  try {
    const env = getEnv();
    const authHeader = req.headers.get("Authorization") || "";
    const authClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const serviceClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);

    const { data, error } = await authClient.auth.getUser();
    if (error || !data.user) {
      return errorResponse("请先登录后再升级 Pro。", 401);
    }

    const stripe = createStripe(env.stripeSecretKey);
    const customerId = await getOrCreateCustomer({
      stripe,
      serviceClient,
      userId: data.user.id,
      email: data.user.email || null
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: env.stripeProMonthlyPriceId, quantity: 1 }],
      success_url: env.stripeSuccessUrl,
      cancel_url: env.stripeCancelUrl,
      metadata: { user_id: data.user.id },
      subscription_data: {
        metadata: { user_id: data.user.id }
      }
    });

    if (!session.url) {
      return errorResponse("Stripe 未返回结账链接。", 500);
    }
    return jsonResponse({ ok: true, url: session.url });
  } catch (error) {
    console.error("Create checkout session error:", error);
    return errorResponse("创建结账链接失败，请稍后重试。", 500);
  }
});

async function getOrCreateCustomer({
  stripe,
  serviceClient,
  userId,
  email
}: {
  stripe: any;
  serviceClient: SupabaseClientLike;
  userId: string;
  email: string | null;
}) {
  const { data: profile, error: profileError } = await serviceClient
    .from("profiles")
    .select("stripe_customer_id,email")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileError) {
    throw profileError;
  }
  if (profile?.stripe_customer_id) {
    return profile.stripe_customer_id as string;
  }

  const customer = await stripe.customers.create({
    email: email || profile?.email || undefined,
    metadata: { user_id: userId }
  });

  const { error } = await serviceClient
    .from("profiles")
    .upsert({
      user_id: userId,
      email: email || profile?.email || null,
      stripe_customer_id: customer.id,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
  if (error) {
    throw error;
  }
  return customer.id;
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
    supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    stripeSecretKey: requireEnv("STRIPE_SECRET_KEY"),
    stripeProMonthlyPriceId: requireEnv("STRIPE_PRO_MONTHLY_PRICE_ID"),
    stripeSuccessUrl: requireEnv("STRIPE_SUCCESS_URL"),
    stripeCancelUrl: requireEnv("STRIPE_CANCEL_URL")
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
