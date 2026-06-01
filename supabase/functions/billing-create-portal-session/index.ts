import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @deno-types="data:application/typescript,declare const Stripe: any; export default Stripe;"
import Stripe from "https://esm.sh/stripe@22.2.0?target=deno&no-dts";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const STRIPE_API_VERSION = "2026-02-25.clover";

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
      return errorResponse("请先登录后再管理订阅。", 401);
    }

    const { data: profile, error: profileError } = await serviceClient
      .from("profiles")
      .select("stripe_customer_id")
      .eq("user_id", data.user.id)
      .maybeSingle();
    if (profileError) {
      throw profileError;
    }
    if (!profile?.stripe_customer_id) {
      return errorResponse("还没有可管理的订阅。", 404);
    }

    const stripe = createStripe(env.stripeSecretKey);
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: env.portalReturnUrl
    });

    return jsonResponse({ ok: true, url: session.url });
  } catch (error) {
    console.error("Create portal session error:", error);
    return errorResponse("创建订阅管理链接失败，请稍后重试。", 500);
  }
});

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
    portalReturnUrl: Deno.env.get("STRIPE_PORTAL_RETURN_URL")
      || Deno.env.get("STRIPE_SUCCESS_URL")
      || "http://localhost:3000/"
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
