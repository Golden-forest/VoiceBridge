// Paddle Webhook Handler
// 验签 → 业务校验 → 构造标准化 effect → 调用 process_billing_event RPC

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Paddle, type EventData } from "npm:@paddle/paddle-node-sdk@3.8.0";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  getBillingEnv,
  createPaddle,
  mapPaddleStatus,
  validatePaddlePrice,
  resolveUserId,
  isPaddleWebhookSource,
  type BillingEnv,
} from "../_shared/paddle.ts";

type SupabaseClientLike = ReturnType<typeof createClient<any, "public", any>>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, message: "Method not allowed" }, 405);
  }

  let serviceClient: SupabaseClientLike | null = null;
  let eventId = "";

  try {
    const env = getBillingEnv();
    serviceClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);
    const paddle = createPaddle(env.paddleApiKey, env.paddleEnvironment);

    // 0. IP allowlist —— 在签名验证之前做，拒绝任何非 Paddle 官方出口 IP 的请求。
    //    IP 列表动态从 api.paddle.com/ips 拉取，带 15 分钟 TTL 缓存。
    //    如果拉取失败（Paddle API 故障），降级为只靠签名验证，不阻断正常业务。
    try {
      const isPaddle = await isPaddleWebhookSource(env.paddleEnvironment, req);
      if (!isPaddle) {
        console.warn("Paddle webhook: source IP not in allowlist");
        return jsonResponse({ ok: false, message: "Forbidden" }, 403);
      }
    } catch (ipError) {
      // Paddle /ips 端点不可用时不阻断（signature verification 仍是主要防线）
      console.warn("Paddle webhook: IP allowlist check skipped:", ipError?.message);
    }

    // 1. 读取原始请求体（验签必须在 JSON 解析前）
    const rawBody = await req.text();
    const signature = req.headers.get("paddle-signature") || "";

    // 2. 验签
    const eventData = await paddle.webhooks.unmarshal(
      rawBody,
      env.paddleWebhookSecret,
      signature,
    );

    if (!eventData) {
      console.warn("Paddle webhook: unmarshal returned null");
      return jsonResponse({ ok: false, message: "Invalid signature" }, 401);
    }

    eventId = eventData.eventId;
    const eventType = eventData.eventType;

    // 3. 解析并构造 effect
    const effect = await buildEffect(serviceClient, env, eventType, eventData);

    // 4. 忽略不支持的事件类型
    if (effect.type === "ignore") {
      const { data: rpcResult } = await serviceClient.rpc("process_billing_event", {
        p_provider: "paddle",
        p_event_id: eventData.eventId,
        p_event_type: eventType,
        p_occurred_at: new Date(eventData.occurredAt).toISOString(),
        p_payload: JSON.parse(rawBody),
        p_effect: effect,
      });
      const action = rpcResult?.[0]?.action || "processed";
      return jsonResponse({ ok: true, action });
    }

    // 5. 调用原子 RPC
    const { data: rpcResult, error: rpcError } = await serviceClient.rpc(
      "process_billing_event",
      {
        p_provider: "paddle",
        p_event_id: eventData.eventId,
        p_event_type: eventType,
        p_occurred_at: new Date(eventData.occurredAt).toISOString(),
        p_payload: JSON.parse(rawBody),
        p_effect: effect,
      },
    );

    if (rpcError) {
      console.error("process_billing_event RPC error:", rpcError);
      return jsonResponse({ ok: false, message: "Internal error" }, 500);
    }

    const action = rpcResult?.[0]?.action || "processed";
    if (action === "failed") {
      // RPC 内部记录了失败，返回非 2xx 让 Paddle 重试
      return jsonResponse({ ok: false, message: "Processing failed, will retry" }, 500);
    }
    // action === 'processed' | 'duplicate' | 'stale' → 都返回 200
    return jsonResponse({ ok: true, action });
  } catch (error) {
    console.error("Paddle webhook error:", error);
    return jsonResponse({ ok: false, message: "Webhook processing failed" }, 500);
  }
});

// ============================================================================
// Effect 构造（业务校验 + 标准化）
// ============================================================================

interface BillingEffect {
  type: string; // "subscription" | "transaction" | "ignore"
  user_id?: string;
  customer_id?: string;
  subscription_id?: string;
  price_id?: string;
  plan?: string;
  status?: string;
  period_start?: string;
  period_end?: string;
  cancel_at_period_end?: boolean;
  state_occurred_at?: string;
  transaction_id?: string;
}

async function buildEffect(
  serviceClient: SupabaseClientLike,
  env: BillingEnv,
  eventType: string,
  eventData: EventData,
): Promise<BillingEffect> {
  const occurredAt = new Date(eventData.occurredAt).toISOString();

  // --- Subscription 事件 ---
  if (eventType.startsWith("subscription.")) {
    return buildSubscriptionEffect(env, occurredAt, eventType, eventData);
  }

  // --- Transaction 事件 ---
  if (eventType.startsWith("transaction.")) {
    return buildTransactionEffect(serviceClient, env, occurredAt, eventType, eventData);
  }

  // --- 其他事件 ---
  return { type: "ignore" };
}

function buildSubscriptionEffect(
  env: BillingEnv,
  occurredAt: string,
  eventType: string,
  eventData: EventData,
): BillingEffect {
  // @ts-ignore: SDK 类型在不同版本间不完全一致，按运行时字段访问
  const sub = eventData.data;
  if (!sub || !sub.id) {
    return { type: "ignore" };
  }

  const customerId = sub.customerId || null;
  const customData = sub.customData || {};
  // 注意：resolveUserId 是 async，这里直接内联
  const customDataUserId = customData?.user_id;

  // 校验 Price
  const items = sub.items || [];
  if (!validatePaddlePrice(items, env.paddlePriceId)) {
    console.warn("Paddle webhook: price mismatch for subscription", sub.id);
    return { type: "ignore" };
  }

  const priceId = items?.[0]?.price?.id || env.paddlePriceId;
  const status = mapPaddleStatus(sub.status || "active");

  return {
    type: "subscription",
    user_id: typeof customDataUserId === "string" ? customDataUserId : undefined,
    customer_id: customerId || undefined,
    subscription_id: sub.id,
    price_id: priceId,
    plan: "pro",
    status,
    period_start: sub.currentBillingPeriod?.startsAt || undefined,
    period_end: sub.currentBillingPeriod?.endsAt || undefined,
    cancel_at_period_end: sub.scheduledChange?.action === "cancel",
    state_occurred_at: occurredAt,
    transaction_id: sub.transactionId || undefined,
  };
}

async function buildTransactionEffect(
  serviceClient: SupabaseClientLike,
  env: BillingEnv,
  occurredAt: string,
  eventType: string,
  eventData: EventData,
): Promise<BillingEffect> {
  // @ts-ignore
  const txn = eventData.data;
  if (!txn || !txn.id) {
    return { type: "ignore" };
  }

  // Transaction 事件不直接更新订阅状态
  // transaction.completed 和 transaction.payment_failed 只更新 latest_transaction_id
  const customData = txn.customData || {};
  const customDataUserId = customData?.user_id;

  // 尝试解析 user_id
  let userId: string | null = null;
  if (typeof customDataUserId === "string") {
    userId = customDataUserId;
  } else if (txn.customerId) {
    userId = await resolveUserId(serviceClient, null, txn.customerId);
  }

  // 对于 transaction.completed，需要查找关联的 subscription_id
  // @ts-ignore
  const subscriptionId = txn.subscriptionId || null;

  if (eventType === "transaction.payment_failed") {
    // 只记录，不改订阅状态
    console.warn("Paddle transaction.payment_failed:", txn.id);
  }

  return {
    type: "transaction",
    user_id: userId || undefined,
    customer_id: txn.customerId || undefined,
    subscription_id: subscriptionId || undefined,
    transaction_id: txn.id,
    // Transaction 事件不传 status/period/cancel 字段，RPC 不会推进订阅状态水位
  };
}
