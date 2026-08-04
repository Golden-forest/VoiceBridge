import test from "node:test";
import assert from "node:assert/strict";

import { createBillingSession, invokeBillingFunction } from "./billing.js";

test("createBillingSession posts to a Supabase Edge Function with auth headers", async () => {
  const calls = [];
  const supabase = createSupabaseClient({
    url: "https://project.supabase.co",
    anonKey: "anon-key",
    accessToken: "access-token"
  });

  const payload = await createBillingSession({
    supabase,
    functionName: "billing-create-checkout-session",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { ok: true, url: "https://checkout.stripe.com/session" });
    }
  });

  assert.deepEqual(payload, { ok: true, url: "https://checkout.stripe.com/session" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://project.supabase.co/functions/v1/billing-create-checkout-session");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.apikey, "anon-key");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token");
});

test("createBillingSession requires a signed-in Supabase session", async () => {
  const supabase = createSupabaseClient({
    url: "https://project.supabase.co",
    anonKey: "anon-key",
    accessToken: ""
  });

  await assert.rejects(
    () => createBillingSession({
      supabase,
      functionName: "billing-create-portal-session",
      fetch: async () => {
        throw new Error("fetch should not be called");
      }
    }),
    /请先登录/
  );
});

test("createBillingSession throws the function error message", async () => {
  const supabase = createSupabaseClient({
    url: "https://project.supabase.co",
    anonKey: "anon-key",
    accessToken: "access-token"
  });

  await assert.rejects(
    () => createBillingSession({
      supabase,
      functionName: "billing-create-checkout-session",
      fetch: async () => jsonResponse(500, { ok: false, message: "Stripe 未配置。" })
    }),
    /Stripe 未配置/
  );
});

test("invokeBillingFunction accepts a successful payload without a redirect URL", async () => {
  const supabase = createSupabaseClient({
    url: "https://project.supabase.co",
    anonKey: "anon-key",
    accessToken: "access-token"
  });

  const payload = await invokeBillingFunction({
    supabase,
    functionName: "billing-get-client-context",
    fetch: async () => jsonResponse(200, { ok: true, paddleCustomerId: null })
  });

  assert.deepEqual(payload, { ok: true, paddleCustomerId: null });
});

function createSupabaseClient({ url, anonKey, accessToken }) {
  return {
    supabaseUrl: url,
    supabaseKey: anonKey,
    auth: {
      async getSession() {
        return {
          data: {
            session: accessToken ? { access_token: accessToken } : null
          },
          error: null
        };
      }
    }
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}
