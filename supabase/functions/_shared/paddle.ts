// Paddle 共享工具：SDK 初始化、配置校验、状态映射、Price 校验、用户解析。
// 被 billing-create-checkout-session / billing-create-portal-session / paddle-webhook 共用。

import { Paddle } from "npm:@paddle/paddle-node-sdk@3.8.0";

export type BillingProvider = "stripe" | "paddle";
export type PaddleEnvironment = "sandbox" | "production";

export interface BillingEnv {
  billingProvider: BillingProvider;
  paddleEnvironment: PaddleEnvironment;
  paddleApiKey: string;
  paddleWebhookSecret: string;
  paddlePriceId: string;
  paddleHostedCheckoutUrl: string;
  paddleDefaultPaymentLink: string;
  paddleSuccessUrl: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function optionalEnv(name: string, fallback = ""): string {
  return Deno.env.get(name) || fallback;
}

/**
 * 读取 billing 配置并在启动时 fail fast 校验。
 */
export function getBillingEnv(): BillingEnv {
  const billingProvider = optionalEnv("BILLING_PROVIDER", "paddle") as BillingProvider;
  if (billingProvider !== "stripe" && billingProvider !== "paddle") {
    throw new Error(`BILLING_PROVIDER must be 'stripe' or 'paddle', got: ${billingProvider}`);
  }

  const paddleEnvironment = optionalEnv("PADDLE_ENVIRONMENT", "sandbox") as PaddleEnvironment;
  if (paddleEnvironment !== "sandbox" && paddleEnvironment !== "production") {
    throw new Error(`PADDLE_ENVIRONMENT must be 'sandbox' or 'production', got: ${paddleEnvironment}`);
  }

  return {
    billingProvider,
    paddleEnvironment,
    paddleApiKey: requireEnv("PADDLE_API_KEY"),
    paddleWebhookSecret: requireEnv("PADDLE_WEBHOOK_SECRET"),
    paddlePriceId: requireEnv("PADDLE_PRICE_ID"),
    paddleHostedCheckoutUrl: optionalEnv("PADDLE_HOSTED_CHECKOUT_URL"),
    paddleDefaultPaymentLink: optionalEnv("PADDLE_DEFAULT_PAYMENT_LINK"),
    paddleSuccessUrl: optionalEnv(
      "PADDLE_SUCCESS_URL",
      "https://voicebridge-6kr.pages.dev/?billing=success"
    ),
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

/**
 * 创建 Paddle SDK 客户端。
 */
export function createPaddle(apiKey: string, environment: PaddleEnvironment): Paddle {
  return new Paddle(apiKey, { environment });
}

/**
 * Paddle Subscription status → DB status
 * 与 0016 迁移中 provider_subscriptions.status 和 subscriptions.status 对齐。
 */
export function mapPaddleStatus(status: string): string {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "paused":
      return "paused";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      return status;
  }
}

/**
 * 校验 Transaction items 中的 priceId 是否匹配允许的 Pro 月订阅 Price。
 */
export function validatePaddlePrice(
  items: Array<{ price?: { id?: string } } | null> | null | undefined,
  allowedPriceId: string
): boolean {
  if (!items || items.length === 0) return false;
  return items.some((item) => item?.price?.id === allowedPriceId);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 从 customData.user_id（主要）或 customer_id 反查（兜底）解析用户 ID。
 * 返回有效 UUID 或 null。
 */
export async function resolveUserId(
  serviceClient: any,
  customData: Record<string, unknown> | null | undefined,
  customerId: string | null | undefined
): Promise<string | null> {
  // 优先从 customData 获取
  const customDataUserId = customData?.user_id;
  if (typeof customDataUserId === "string" && UUID_REGEX.test(customDataUserId)) {
    return customDataUserId;
  }

  // 兜底：通过 billing_customers 反查
  if (customerId) {
    const { data, error } = await serviceClient
      .from("billing_customers")
      .select("user_id")
      .eq("provider", "paddle")
      .eq("provider_customer_id", customerId)
      .maybeSingle();
    if (!error && data?.user_id) {
      return data.user_id as string;
    }
  }

  return null;
}

/**
 * 把 Transaction ID 加到 Hosted Checkout URL。
 */
export function buildCheckoutUrl(hostedCheckoutUrl: string, transactionId: string): string {
  const url = new URL(hostedCheckoutUrl);
  url.searchParams.set("transaction_id", transactionId);
  return url.toString();
}
