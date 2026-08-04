// Returns Paddle.js client context for the signed-in user.
// The stored customer ID is verified against the currently configured Paddle
// environment so a sandbox ctm_* can never be passed to live Paddle Retain.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getBillingEnv, paddleApiBaseUrl } from "../_shared/paddle.ts";

const PADDLE_CUSTOMER_ID = /^ctm_[a-z0-9]{26}$/;

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
      return errorResponse("请先登录。", 401);
    }

    const { data: mapping, error: mappingError } = await serviceClient
      .from("billing_customers")
      .select("provider_customer_id")
      .eq("user_id", data.user.id)
      .eq("provider", "paddle")
      .maybeSingle();
    if (mappingError) throw mappingError;

    const customerId = mapping?.provider_customer_id;
    if (typeof customerId !== "string" || !PADDLE_CUSTOMER_ID.test(customerId)) {
      return jsonResponse({ ok: true, paddleCustomerId: null });
    }

    // Customer IDs live in separate sandbox/live accounts. Verifying the ID
    // through the active API prevents stale sandbox mappings reaching pwCustomer.
    const paddleResponse = await fetch(
      `${paddleApiBaseUrl(env.paddleEnvironment)}/customers/${encodeURIComponent(customerId)}`,
      {
        headers: {
          Authorization: `Bearer ${env.paddleApiKey}`,
          Accept: "application/json",
        },
      },
    );

    if (paddleResponse.status === 404) {
      return jsonResponse({ ok: true, paddleCustomerId: null });
    }
    if (!paddleResponse.ok) {
      throw new Error(`Paddle customer validation failed: ${paddleResponse.status}`);
    }

    const payload = await paddleResponse.json();
    const verifiedId = payload?.data?.id;
    return jsonResponse({
      ok: true,
      paddleCustomerId: verifiedId === customerId ? customerId : null,
    });
  } catch (error) {
    console.error("Get billing client context error:", error);
    return errorResponse("暂时无法加载 Paddle 客户上下文。", 500);
  }
});

function errorResponse(message: string, status: number) {
  return jsonResponse({ ok: false, message }, status);
}
