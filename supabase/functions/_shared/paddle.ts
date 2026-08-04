// Paddle 共享工具：SDK 初始化、配置校验、状态映射、Price 校验、用户解析。
// 被 billing-create-checkout-session / billing-create-portal-session / paddle-webhook 共用。

import { Paddle } from "npm:@paddle/paddle-node-sdk@3.8.0";

export type BillingProvider = "stripe" | "paddle";
export type PaddleEnvironment = "production";

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
 * 读取 Paddle 环境并强制使用 production。
 * 不做 requireEnv 校验，可被非关键路径（如 account-delete）安全调用：
 * 即使 PADDLE_API_KEY 未配置也不会抛错。
 */
export function getPaddleEnvironment(): PaddleEnvironment {
  const env = optionalEnv("PADDLE_ENVIRONMENT", "production");
  if (env !== "production") {
    throw new Error(`PADDLE_ENVIRONMENT must be 'production' in this build, got: ${env}`);
  }
  return "production";
}

/**
 * Paddle API base URL，按环境路由。
 */
export function paddleApiBaseUrl(environment: PaddleEnvironment): string {
  if (environment !== "production") {
    throw new Error(`Unsupported Paddle environment: ${environment}`);
  }
  return "https://api.paddle.com";
}

// ---------------------------------------------------------------------------
// Paddle webhook IP allowlist
// ---------------------------------------------------------------------------
// 官方安全建议：动态拉取 https://api.paddle.com/ips 并 allowlist 这些来源，
// 拒绝其它任何 IP 的 webhook 投递。列表会变化，不能硬编码。
// 参考文档：https://developer.paddle.com/webhooks/5279353-1-validate-events-and-secure-your-webhook-endpoint

const PADDLE_IP_CACHE_TTL_MS = 15 * 60 * 1000; // 15 分钟
let cachedPaddleIps: string[] | null = null;
let cachedPaddleIpsExpiresAt = 0;

/**
 * 拉取当前环境的 Paddle webhook 出口 IP 列表（CIDR /32 形式）。
 * 带 TTL 缓存避免每次 webhook 请求都打 Paddle API。
 */
export async function fetchPaddleWebhookIps(
  environment: PaddleEnvironment,
): Promise<string[]> {
  const now = Date.now();
  if (cachedPaddleIps && now < cachedPaddleIpsExpiresAt) {
    return cachedPaddleIps;
  }

  const baseUrl = paddleApiBaseUrl(environment);
  const resp = await fetch(`${baseUrl}/ips`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch Paddle IPs: ${resp.status} ${await resp.text()}`);
  }
  const body = await resp.json();
  const ips: string[] = (body?.data?.ipv4_cidrs ?? []).map((c: string) => c.split("/")[0]);

  if (ips.length === 0) {
    throw new Error("Paddle IP list is empty");
  }

  cachedPaddleIps = ips;
  cachedPaddleIpsExpiresAt = now + PADDLE_IP_CACHE_TTL_MS;
  return ips;
}

/**
 * 判断请求来源 IP 是否在 Paddle 的 allowlist 内。
 * Supabase Edge Functions 的真实客户端 IP 由平台注入（CF-Connecting-IP / X-Forwarded-For）。
 */
export async function isPaddleWebhookSource(
  environment: PaddleEnvironment,
  req: Request,
): Promise<boolean> {
  // Supabase 使用 Cloudflare，真实 IP 优先从 CF-Connecting-IP 取
  const directIp =
    req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim();

  if (!directIp) return false;

  const allowlist = await fetchPaddleWebhookIps(environment);
  return allowlist.includes(directIp);
}

/**
 * 读取 billing 配置并在启动时 fail fast 校验。
 */
export function getBillingEnv(): BillingEnv {
  const billingProvider = optionalEnv("BILLING_PROVIDER", "paddle") as BillingProvider;
  if (billingProvider !== "stripe" && billingProvider !== "paddle") {
    throw new Error(`BILLING_PROVIDER must be 'stripe' or 'paddle', got: ${billingProvider}`);
  }

  // 复用单一真相源，避免环境判断散落多处。
  const paddleEnvironment = getPaddleEnvironment();

  return {
    billingProvider,
    paddleEnvironment,
    paddleApiKey: requireEnv("PADDLE_API_KEY"),
    paddleWebhookSecret: requireEnv("PADDLE_WEBHOOK_SECRET"),
    paddlePriceId: requireEnv("PADDLE_PRICE_ID"),
    paddleHostedCheckoutUrl: optionalEnv("PADDLE_HOSTED_CHECKOUT_URL"),
    paddleDefaultPaymentLink: optionalEnv("PADDLE_DEFAULT_PAYMENT_LINK"),
    paddleSuccessUrl: requireEnv("PADDLE_SUCCESS_URL"),
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
