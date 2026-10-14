import assert from "node:assert/strict";
import test from "node:test";
import { loadEdgeHandler, postJson } from "./edge_test_support.js";

const userId = "11111111-1111-4111-8111-111111111111";
const env = {
  supabaseUrl: "https://local.invalid", supabaseServiceRoleKey: "service",
  billingProvider: "paddle", paddlePriceId: "pri_test", paddleSuccessUrl: "https://local.invalid/pay",
  paddleEnvironment: "production"
};

async function webhook({ result = "processed", error = null, ignore = false } = {}) {
  return loadEdgeHandler("../paddle-webhook/index.ts", {
    createClient: () => ({ rpc: async () => ({ data: result, error }) }), getBillingEnv: () => env,
    createPaddle: () => ({ webhooks: { unmarshal: async () => ({
      eventId: "evt_test", eventType: ignore ? "customer.created" : "subscription.created", occurredAt: "2026-01-01T00:00:00Z",
      data: { id: "sub_test", customerId: "ctm_test", customData: { user_id: userId }, items: [{ price: { id: "pri_test" } }], status: "active" }
    }) } }), mapPaddleStatus: s => s, validatePaddlePrice: () => true,
    resolveUserId: async () => null, isPaddleWebhookSource: async () => true
  });
}

test("webhook preserves scalar success actions and refuses failure/unknown contracts", async () => {
  for (const action of ["processed", "duplicate", "stale"]) {
    const { handler } = await webhook({ result: action });
    const response = await handler(postJson());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).action, action);
  }
  for (const result of ["failed", null, [{ action: "processed" }], "unexpected"]) {
    const { handler } = await webhook({ result });
    assert.equal((await handler(postJson())).status, 500);
  }
});

test("webhook ignore path also retries RPC failures", async () => {
  const { handler } = await webhook({ ignore: true, error: new Error("database unavailable") });
  assert.equal((await handler(postJson())).status, 500);
});

async function stripeWebhook({ result = "processed", rpcError = null, markerError = null } = {}) {
  const rpcCalls = [], updates = [];
  let markers = 0;
  const client = {
    rpc: async (_fn, params) => {
      rpcCalls.push(params);
      return { data: typeof result === "function" ? await result(params) : result, error: rpcError };
    },
    from(table) {
      return {
        insert: async () => { markers++; return { error: typeof markerError === "function" ? markerError() : markerError }; },
        update(params) { updates.push({ table, params }); return this; },
        eq() { return this; }, in() { return this; },
        then(resolve) { resolve({ error: null }); }
      };
    }
  };
  const loaded = await loadEdgeHandler("../stripe-webhook/index.ts", {
    createClient: () => client,
    Stripe: class {
      static createFetchHttpClient() { return {}; }
      static createSubtleCryptoProvider() { return {}; }
      webhooks = { constructEventAsync: async body => JSON.parse(body) };
    }
  });
  const request = event => new Request("https://local.invalid/webhook", {
    method: "POST", headers: { "stripe-signature": "dummy" }, body: JSON.stringify(event)
  });
  return { ...loaded, request, rpcCalls, updates, markers: () => markers };
}

const stripeSubscriptionEvent = (id = "evt_1") => ({
  id, type: "customer.subscription.updated", created: 1767225600,
  data: { object: { id: "sub_test", customer: "cus_test", metadata: { user_id: userId },
    items: { data: [{ price: { id: "price_test" } }] }, status: "active" } }
});

test("Stripe existing legacy marker cannot acknowledge a failed/unknown billing RPC", async () => {
  for (const result of ["failed", null, { action: "processed" }]) {
    const { handler, request, markers, rpcCalls, updates } = await stripeWebhook({ result, markerError: { code: "23505" } });
    assert.equal((await handler(request(stripeSubscriptionEvent()))).status, 500);
    assert.equal(rpcCalls.length, 1);
    assert.equal(markers(), 0, "the legacy marker is only touched after confirmed processing");
    assert.equal(updates.length, 0);
  }
});

test("Stripe concurrent delivery waits for its atomic billing RPC before acknowledgment", async () => {
  let unlock, entered, count = 0, acknowledged = 0;
  const gate = new Promise(resolve => { unlock = resolve; });
  const bothEntered = new Promise(resolve => { entered = resolve; });
  const { handler, request, markers } = await stripeWebhook({
    result: async () => {
      const current = ++count;
      if (count === 2) entered();
      await gate;
      return current === 1 ? "processed" : "duplicate";
    }, markerError: { code: "23505" }
  });
  const pending = [1, 2].map(() => handler(request(stripeSubscriptionEvent())).then(response => { acknowledged++; return response; }));
  await bothEntered;
  assert.equal(acknowledged, 0);
  assert.equal(markers(), 0);
  unlock();
  assert.deepEqual((await Promise.all(pending)).map(response => response.status), [200, 200]);
  assert.equal(markers(), 2);
});

test("Stripe completion-marker failure can retry an already processed billing RPC", async () => {
  let processed = 0, writes = 0;
  const { handler, request, rpcCalls } = await stripeWebhook({
    result: () => ++processed === 1 ? "processed" : "duplicate",
    markerError: () => ++writes === 1 ? { code: "database_unavailable" } : null
  });
  assert.equal((await handler(request(stripeSubscriptionEvent()))).status, 500);
  assert.equal((await handler(request(stripeSubscriptionEvent()))).status, 200);
  assert.equal(rpcCalls.length, 2);
});

test("Stripe same-status updates use distinct signed event IDs and preserve the projected entitlement", async () => {
  const { handler, request, rpcCalls, updates } = await stripeWebhook();
  for (const id of ["evt_1", "evt_2"]) assert.equal((await handler(request(stripeSubscriptionEvent(id)))).status, 200);
  assert.deepEqual(rpcCalls.map(p => p.p_event_id), ["evt_1", "evt_2"]);
  assert.equal(rpcCalls[0].p_occurred_at, "2026-01-01T00:00:00.000Z");
  assert.equal(rpcCalls[0].p_effect.state_occurred_at, "2026-01-01T00:00:00.000Z");
  assert.equal(updates[0].params.stripe_subscription_id, "sub_test");
  assert.equal("plan" in updates[0].params, false);
  assert.equal("status" in updates[0].params, false);
  const stale = await stripeWebhook({ result: "stale" });
  assert.equal((await stale.handler(stale.request(stripeSubscriptionEvent()))).status, 200);
  assert.equal(stale.updates.length, 0);
});

test("Stripe signed completed/expired sessions close their checkout attempt", async () => {
  for (const status of ["completed", "expired"]) {
    const { handler, request, updates } = await stripeWebhook();
    const event = { id: "evt_session", type: `checkout.session.${status}`, created: 1767225600,
      data: { object: { id: "cs_test" } } };
    assert.equal((await handler(request(event))).status, 200);
    assert.equal(updates[0].table, "billing_checkout_attempts");
    assert.equal(updates[0].params.status, status);
  }
});

async function deleting({ facts = [], current = null, fetch: fetchImpl, queryError = null, checkout = [], checkoutError = null } = {}) {
  let deleted = 0;
  const client = {
    auth: { getClaims: async () => ({ data: { claims: { sub: userId } }, error: null }), admin: {
      deleteUser: async () => { deleted++; return { error: null }; }
    } },
    rpc: async (fn, params) => {
      assert.equal(fn, "begin_account_deletion");
      assert.equal(params.p_user_id, userId);
      return { data: checkout.length ? "checkout_pending" : "account_deleting", error: checkoutError };
    },
    from(table) {
      return { select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: table === "profiles" ? { is_admin: false } : current, error: queryError }; },
        then(resolve) { resolve({ data: facts, error: queryError }); }
      };
    }
  };
  const loaded = await loadEdgeHandler("../account-delete/index.ts", {
    createClient: () => client, getPaddleEnvironment: () => "production",
    paddleApiBaseUrl: () => "https://local.invalid", fetch: fetchImpl
  });
  return { ...loaded, deleted: () => deleted };
}

const paddleCurrent = { source_provider: "paddle", source_subscription_id: "sub_active", status: "active" };

test("account deletion keeps ownership while creating/open checkout may still be paid", async () => {
  for (const status of ["creating", "open"]) {
    const { handler, deleted } = await deleting({
      checkout: [{ id: "attempt_pending", status }],
      fetch: async () => { throw new Error("must not call a provider before the pending-checkout gate"); }
    });
    const response = await handler(postJson());
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "checkout_pending");
    assert.equal(deleted(), 0);
  }
});

test("account deletion fails closed when pending-checkout state cannot be read", async () => {
  const { handler, deleted } = await deleting({ checkoutError: new Error("database unavailable") });
  assert.equal((await handler(postJson())).status, 500);
  assert.equal(deleted(), 0);
});

test("account deletion keeps account on cancellation HTTP error, timeout and non-canceled response", async () => {
  for (const failure of ["http", "timeout", "not-canceled"]) {
    const { handler, deleted } = await deleting({ current: paddleCurrent,
      fetch: async (_url, init) => {
        if (!init.method) return Response.json({ data: { status: "active" } });
        if (failure === "timeout") throw new Error("timeout");
        if (failure === "http") return Response.json({}, { status: 404 });
        return Response.json({ data: { status: "active" } });
      }
    });
    const response = await handler(postJson());
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "subscription_cancel_failed");
    assert.equal(deleted(), 0);
  }
});

test("account deletion cancels all live provider facts, deduplicates projection and skips already canceled provider", async () => {
  const calls = [];
  const { handler, deleted } = await deleting({
    facts: [
      { provider: "paddle", provider_subscription_id: "sub_active", status: "trialing" },
      { provider: "stripe", provider_subscription_id: "sub_due", status: "past_due" },
      { provider: "paddle", provider_subscription_id: "sub_already", status: "paused" }
    ], current: paddleCurrent,
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      const paddle = !url.includes("stripe.com");
      const status = !init.method && !url.includes("sub_already") ? "active" : "canceled";
      return Response.json(paddle ? { data: { status } } : { status });
    }
  });
  assert.equal((await handler(postJson())).status, 200);
  assert.equal(deleted(), 1);
  const cancellations = calls.filter(c => c.method);
  assert.equal(cancellations.length, 2);
  assert.match(cancellations[0].url, /\/subscriptions\/sub_active\/cancel$/);
  assert.equal(JSON.parse(cancellations[0].body).effective_from, "immediately");
  assert.equal(cancellations[1].method, "DELETE");
});

test("account deletion retains associations when provider lookup fails", async () => {
  const { handler, deleted } = await deleting({ current: paddleCurrent, fetch: async () => Response.json({}, { status: 503 }) });
  assert.equal((await handler(postJson())).status, 502);
  assert.equal(deleted(), 0);
});

test("account deletion permits Stripe terminal incomplete_expired but retains unknown states", async () => {
  for (const status of ["incomplete_expired", "future_unknown_status"]) {
    let canceled = false;
    const { handler, deleted } = await deleting({
      facts: [{ provider: "stripe", provider_subscription_id: "sub_expired", status: "incomplete" }],
      fetch: async (_url, init) => {
        if (init.method) canceled = true;
        return Response.json({ status });
      }
    });
    assert.equal((await handler(postJson())).status, status === "incomplete_expired" ? 200 : 502);
    assert.equal(deleted(), status === "incomplete_expired" ? 1 : 0);
    assert.equal(canceled, false);
  }
});

async function checkout({ createFailure = null, busy = false, accountDeleting = false, subscriptionPending = false, provider = "paddle", profileError = null, saveError = null } = {}) {
  let claimed = false, started = false, transactions = 0, customers = 0;
  const attempt = { id: "attempt_test", status: "creating", provider };
  const updates = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    from: table => ({ select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: null, error: table === "profiles" ? profileError : null }),
      upsert: async () => ({ error: saveError })
    }),
    async rpc(fn, p) {
      if (fn === "claim_checkout_attempt") {
        assert.equal(p.p_provider, provider);
        if (accountDeleting) return { data: { status: "account_deleting", acquired: false }, error: null };
        if (subscriptionPending) return { data: { status: "subscription_pending", acquired: false }, error: null };
        const acquired = !busy && !claimed;
        claimed = true;
        return { data: { ...attempt, acquired, lease_token: acquired ? "lease_test" : null }, error: null };
      }
      if (fn === "start_checkout_provider_request") {
        assert.equal(p.p_lease_token, "lease_test");
        const result = !started; started = true;
        return { data: result, error: null };
      }
      if (fn === "update_checkout_attempt") {
        updates.push(p);
        Object.assign(attempt, { status: p.p_status, checkout_url: p.p_checkout_url, provider_transaction_id: p.p_provider_transaction_id });
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${fn}`);
    }
  };
  const loaded = await loadEdgeHandler("../billing-create-checkout-session/index.ts", {
    createClient: () => client, getBillingEnv: () => ({ ...env, billingProvider: provider }),
    createPaddle: () => ({ transactions: { async create(params) {
      transactions++; assert.equal(params.customData.checkout_attempt_id, "attempt_test");
      if (createFailure) throw createFailure;
      return { id: "txn_test", checkout: { url: "https://local.invalid/checkout" } };
    } } }),
    Stripe: class {
      static createFetchHttpClient() { return {}; }
      customers = { create: async (_params, options) => {
        customers++; assert.equal(options.idempotencyKey, "voicebridge-customer:attempt_test");
        return { id: "cus_test" };
      } };
      checkout = { sessions: { create: async (params, options) => {
        transactions++;
        assert.equal(params.metadata.checkout_attempt_id, "attempt_test");
        assert.equal(options.idempotencyKey, "voicebridge-checkout:attempt_test");
        if (createFailure) throw createFailure;
        return { id: "cs_test", url: "https://local.invalid/checkout" };
      } } };
    }
  });
  return { ...loaded, transactions: () => transactions, customers: () => customers, updates };
}

test("checkout concurrent callers create only one transaction", async () => {
  const { handler, transactions, updates } = await checkout();
  const responses = await Promise.all([handler(postJson()), handler(postJson())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(transactions(), 1);
  assert.equal(updates[0].p_lease_token, "lease_test");
});

test("deletion intent blocks checkout for both providers before customer/session creation", async () => {
  for (const provider of ["paddle", "stripe"]) {
    const { handler, transactions, customers } = await checkout({ provider, accountDeleting: true });
    assert.equal((await handler(postJson())).status, 409);
    assert.equal(transactions(), 0);
    assert.equal(customers(), 0);
  }
});

test("paid checkout awaiting its subscription fact blocks both providers from creating a second purchase", async () => {
  for (const provider of ["paddle", "stripe"]) {
    const { handler, transactions, customers } = await checkout({ provider, subscriptionPending: true });
    const response = await handler(postJson());
    assert.equal(response.status, 409);
    assert.match((await response.json()).message, /正在确认订阅权益/);
    assert.equal(transactions(), 0);
    assert.equal(customers(), 0);
  }
});

test("checkout timeout remains uncertain while definite provider rejection permits retry", async () => {
  for (const [error, expected] of [[new Error("timeout"), "creating"], [Object.assign(new Error("bad request"), { type: "request_error", code: "invalid_field" }), "failed"]]) {
    const { handler, updates } = await checkout({ createFailure: error });
    assert.equal((await handler(postJson())).status, 500);
    assert.equal(updates[0].p_status, expected);
  }
});

test("Stripe concurrent checkout shares the lease and reuses the stored session", async () => {
  const { handler, transactions, customers, updates } = await checkout({ provider: "stripe" });
  const responses = await Promise.all([handler(postJson()), handler(postJson())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const reused = await handler(postJson());
  assert.equal(reused.status, 200);
  assert.equal((await reused.json()).url, "https://local.invalid/checkout");
  assert.equal(transactions(), 1);
  assert.equal(customers(), 1);
  assert.equal(updates[0].p_provider_transaction_id, "cs_test");
  assert.equal(updates[0].p_lease_token, "lease_test");
});

test("Stripe timeout remains busy and validation failure is the only retriable session failure", async () => {
  for (const [error, expected] of [[new Error("timeout"), "creating"], [Object.assign(new Error("bad price"), { type: "StripeInvalidRequestError", statusCode: 400 }), "failed"]]) {
    const { handler, transactions, updates } = await checkout({ provider: "stripe", createFailure: error });
    assert.equal((await handler(postJson())).status, 500);
    assert.equal(updates[0].p_status, expected);
    if (expected === "creating") {
      assert.equal((await handler(postJson())).status, 409);
      assert.equal(transactions(), 1);
    }
  }
});

test("Stripe customer query and persistence failures do not create a payable session", async () => {
  for (const failures of [{ profileError: new Error("query failed") }, { saveError: new Error("save failed") }]) {
    const { handler, transactions, updates } = await checkout({ provider: "stripe", ...failures });
    assert.equal((await handler(postJson())).status, 500);
    assert.equal(transactions(), 0);
    assert.equal(updates.length, 0);
  }
});
