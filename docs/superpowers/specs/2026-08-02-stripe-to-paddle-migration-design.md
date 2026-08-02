# Stripe → Paddle 支付迁移设计

**日期**：2026-08-02
**状态**：已确认，待制定实施计划
**方案**：A（纯后端 API，前端零改动）

## 背景与动机

VoiceBridge 当前使用 Stripe 作为唯一支付提供商，实现了 Pro 月订阅的完整链路：Checkout → Webhook → 配额生效。用户（项目所有者）位于中国，只有国内银行卡，无法注册 Stripe。Paddle 作为 Merchant of Record 平台，支持中国开发者注册，且代收全球销售税/VAT，适合面向全球用户的 SaaS 产品。

## 目标

将支付后端从 Stripe 迁移到 Paddle，同时满足：
- 前端代码零改动（`billing.js`、`app.js`、`billing.test.js` 均不变）
- 配额执行链路不变（`reserve_and_get_plan` RPC + `transcribe` Edge Function 不变）
- 三档套餐（free/pro/admin）语义不变
- 幂等 webhook 处理保持等价

## 非目标

- 不做 Paddle.js 前端 Overlay 模式（保留为未来优化项）
- 不处理历史 Stripe 数据迁移（内测期无真实付费用户）
- 不变更套餐定价或配额

## 整体架构

```
[前端 PWA]                    [Supabase Edge Functions]           [Paddle API]
  app.js                        billing-create-checkout-session  →   checkouts.create
  billing.js                    billing-create-portal-session    →   subscriptions.get (management_urls)
       ↓                        paddle-webhook                   ←   webhook events
  openBillingSession()
       ↓                        [PostgreSQL]
  location.href 跳转             subscriptions 表 (upsert)
                               profiles 表 (paddle_customer_id)
                               paddle_events 表 (幂等去重)
                               reserve_and_get_plan RPC (不变)
```

**不变的部分**：
- `subscriptions` 表（字段重命名，语义不变）、`profiles` 表、`usage_events` 表
- `reserve_and_get_plan` RPC + 配额执行逻辑
- `transcribe` Edge Function
- 前端全部文件

**替换的部分**：
- 3 个 Stripe Edge Function → 3 个 Paddle Edge Function（其中 2 个原地重写，1 个新建+1 个删除）
- `stripe_events` 幂等表 → 新增 `paddle_events` 幂等表（`stripe_events` 保留存档）
- 环境变量从 Stripe 的 6 个 → Paddle 的 5 个

## 数据库 Migration

**新增 migration**：`supabase/migrations/0015_migrate_stripe_to_paddle.sql`

### 字段重命名

```sql
-- profiles 表
alter table public.profiles rename column stripe_customer_id to paddle_customer_id;

-- subscriptions 表
alter table public.subscriptions rename column stripe_customer_id to paddle_customer_id;
alter table public.subscriptions rename column stripe_subscription_id to paddle_subscription_id;
alter table public.subscriptions rename column stripe_price_id to paddle_price_id;

-- 唯一索引重命名（如果存在）
alter index if exists public.subscriptions_stripe_subscription_id_key
  rename to subscriptions_paddle_subscription_id_key;
```

### 新增 paddle_events 表

```sql
create table if not exists public.paddle_events (
  id text primary key,          -- evt_xxx
  type text not null,           -- subscription.created 等
  processed_at timestamptz not null default now()
);
alter table public.paddle_events enable row level security;
-- 仅 service_role 可写
```

### 保留

- `stripe_events` 表保留，不删除（存档，避免回滚风险）
- 所有历史 migration 文件保留不动

### 不受影响

- `reserve_and_get_plan` RPC 不直接引用 `stripe_*` 字段，不受重命名影响
- `subscriptions` 表的 `plan`、`status`、`current_period_start/end`、`cancel_at_period_end` 字段名不变（语义通用）

## Edge Function 重写（核心）

### billing-create-checkout-session/index.ts（原地重写）

**流程**：验证 JWT → `getOrCreateCustomer`（含 address）→ `paddle.checkouts.create` → 返回 hosted checkout URL

**Stripe → Paddle 差异**：

| 概念 | Stripe | Paddle |
|------|--------|--------|
| Customer | `stripe.customers.create` | `paddle.customers.create` |
| Address | 不需要单独创建 | 需要 `paddle.addresses.create`（结账前置条件） |
| Checkout | `checkout.sessions.create({ line_items })` | `paddle.checkouts.create({ items })` |
| 元数据 | `metadata: { user_id }` | `custom_data: { user_id }` |
| 返回 URL | `success_url` / `cancel_url` | checkout settings 中 `successUrl` |

**getOrCreateCustomer 逻辑**：
1. 查 `profiles.paddle_customer_id`
2. 若无 → `paddle.customers.create({ email })` → `paddle.addresses.create({ customerId, countryCode })` → 回写 profiles
3. 返回 customerId + addressId

**创建 checkout**：
```typescript
const checkout = await paddle.checkouts.create({
  collection_mode: "automatic",
  customer_id: customerId,
  address_id: addressId,
  items: [{ price_id: env.paddlePriceId, quantity: 1 }],
  custom_data: { user_id: userId },
  // successUrl 在 checkout settings 中设置
});
return jsonResponse({ ok: true, url: checkout.url });
```

### billing-create-portal-session/index.ts（原地重写）

**流程**：验证 JWT → 查用户 active subscription → 用 Paddle API 获取 `management_urls` → 返回 URL

**简化**：Paddle subscription 自带 `management_urls`（`update_payment_method` / `cancel`），不需要像 Stripe 那样创建 portal session。

```typescript
// 查 subscriptions 表拿 paddle_subscription_id
// 调 paddle.subscriptions.get() 获取最新状态
// 返回 management_urls.update_payment_method 或 .cancel
```

### paddle-webhook/index.ts（新增，替代 stripe-webhook）

**流程**：验签 → 幂等去重 → 事件分发 → upsertSubscription

#### 签名验证

Paddle header 格式：`ts=<timestamp>;h1=<hmac_hex>`

```typescript
// SDK 方式（优先）
const eventData = await paddle.webhooks.unmarshal(rawBody, secretKey, signature);

// 手动方式（fallback）
// signed_payload = `${timestamp}:${rawBody}`
// HMAC-SHA256(secretKey, signedPayload) === h1
// 额外校验：timestamp 与当前时间差 > 5 秒则拒绝（防重放）
```

#### 事件映射

| Stripe 事件 | Paddle 事件 | 处理逻辑 |
|---|---|---|
| `checkout.session.completed` | `transaction.completed` | 从 `custom_data.user_id` 取 userId，更新 profiles.paddle_customer_id |
| `customer.subscription.created` | `subscription.created` | upsertSubscription |
| `customer.subscription.updated` | `subscription.updated` | upsertSubscription |
| `customer.subscription.deleted` | `subscription.canceled` | upsertSubscription (status=canceled) |
| `invoice.paid` | `subscription.updated`（含续费） | upsertSubscription |
| `invoice.payment_failed` | `transaction.payment_failed` | upsertSubscription (status=past_due) |

#### upsertSubscription 字段映射

```typescript
{
  user_id: userId,                                          // 从 custom_data 解析
  paddle_customer_id: sub.customer_id,                      // ctm_xxx
  paddle_subscription_id: sub.id,                           // sub_xxx
  paddle_price_id: sub.items[0].price.id,                   // pri_xxx
  plan: "pro",                                               // 固定写 pro
  status: mapPaddleStatus(sub.status),
  current_period_start: sub.current_billing_period?.starts_at,
  current_period_end: sub.current_billing_period?.ends_at,
  cancel_at_period_end: sub.scheduled_change?.action === "cancel",
}
```

#### Paddle status 映射

| Paddle status | DB status | isPaidStatus |
|---|---|---|
| `active` | `active` | true |
| `trialing` | `trialing` | true |
| `paused` | `paused` | false |
| `past_due` | `past_due` | false |
| `canceled` | `canceled` | false |

#### 幂等去重

与 Stripe webhook 逻辑相同：用 `paddle_events` 表 PK (`event_id`) 去重，23505 唯一约束冲突 → 跳过。出错时回滚（删除刚插入的 event 记录）。

### _shared/paddle.ts（新增）

提取 Paddle SDK 初始化和共享工具函数：
- `createPaddle(apiKey, environment)` — 返回 Paddle 客户端实例
- `getEnv()` — 读取 Paddle 环境变量
- `mapPaddleStatus(status)` — Paddle status → DB status 映射
- `resolveUserId(serviceClient, { customDataUserId, paddleCustomerId })` — 从 custom_data 或 customer_id 反查 userId

## 前端改动

**零改动。**

| 文件 | 改动 |
|------|------|
| `src/public/billing.js` | 零 — `createBillingSession()` 函数签名不变 |
| `hosted-pwa/public/billing.js` | 零 — 镜像 |
| `src/public/app.js` | 零 — `openBillingSession("billing-create-checkout-session")` 调用不变 |
| `hosted-pwa/public/app.js` | 零 — 镜像 |
| `billing.test.js`（× 2） | 零 — 断言路径 `/functions/v1/billing-create-checkout-session` 不变 |

`?billing=success` / `?billing=cancel` 回调逻辑完全复用——Paddle hosted checkout 通过 `PADDLE_RETURN_URL` 设置同样的 URL 参数。

## 配置与部署

### 环境变量

**删除（6 个 Stripe 变量）**：
```
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRO_MONTHLY_PRICE_ID,
STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL, STRIPE_PORTAL_RETURN_URL
```

**新增（5 个 Paddle 变量）**：
```
PADDLE_API_KEY=               # API key
PADDLE_WEBHOOK_SECRET=        # Webhook 签名密钥
PADDLE_PRICE_ID=              # Pro 月订阅 price ID (pri_xxx)
PADDLE_ENVIRONMENT=sandbox    # sandbox 或 production
PADDLE_RETURN_URL=https://voicebridge-6kr.pages.dev/?billing=success
```

### supabase/config.toml

```toml
# 改动
[functions.paddle-webhook]    # 替代 [functions.stripe-webhook]
verify_jwt = false

# 不变
[functions.billing-create-checkout-session]
verify_jwt = true
[functions.billing-create-portal-session]
verify_jwt = true
```

### package.json

```jsonc
// 删除
"stripe": "^22.2.0"
// 新增（可选，仅本地类型提示）
"@paddle/paddle-node-sdk": "^2.x"
```

### src/server/config.js

`loadConfig()` 中 Stripe 变量名 → Paddle 变量名。`buildPublicConfig()` 安全过滤逻辑不变（同样排除 Paddle 密钥）。

### .env.example

Stripe 部分 → Paddle 部分，附 sandbox/production 注释。

### Supabase Secret 部署

```bash
# 删除旧 Stripe secrets
supabase secrets unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRO_MONTHLY_PRICE_ID

# 设置 Paddle secrets
supabase secrets set PADDLE_API_KEY=... PADDLE_WEBHOOK_SECRET=... PADDLE_PRICE_ID=... PADDLE_RETURN_URL=...
```

### Paddle Dashboard 配置

**Webhook endpoint**：
```
POST https://<supabase-project>.supabase.co/functions/v1/paddle-webhook
```

**订阅事件**：
- `transaction.completed`
- `transaction.payment_failed`
- `subscription.created`
- `subscription.updated`
- `subscription.canceled`

## 测试策略

### 新增测试

1. **Webhook 签名验证测试**（`supabase/functions/_shared/paddle_webhook.test.js`）
   - 有效签名 → 正确解析 event
   - 无效签名 → 拒绝
   - 过期 timestamp（>5 秒）→ 拒绝
   - 缺少 `paddle-signature` header → 400

2. **Webhook 事件处理测试**（`supabase/functions/paddle-webhook/paddle_webhook.test.js`）
   - `transaction.completed` → 解析 `custom_data.user_id`，更新 profiles + upsert subscription
   - `subscription.updated` → upsert subscription，status 映射正确
   - `subscription.canceled` → subscription status = canceled
   - `transaction.payment_failed` → subscription status = past_due
   - 重复 event_id → 幂等跳过

3. **Checkout Session 测试**（mock Paddle API）
   - 已登录用户 → 返回 `{ ok: true, url }`
   - 未登录 → 401
   - 无 paddle_customer_id → 调用 `customers.create` + `addresses.create`
   - 已有 paddle_customer_id → 跳过创建

### 现有测试

| 文件 | 状态 |
|------|------|
| `billing.test.js`（前端，× 2） | 不变 |
| `planLimits.test.js` | 不变 |
| `config.test.js` | 小改 — 密钥排除断言从 `STRIPE_*` 改为 `PADDLE_*` |

### 端到端验证（手动）

1. Paddle Sandbox 创建 Pro 月订阅产品，获取 `price_id`
2. 设置 Sandbox webhook → Edge Function URL
3. 前端点击"升级" → Paddle hosted checkout 打开
4. 用 Sandbox 测试卡支付
5. 验证 webhook 触发 → `subscriptions` 表 plan=pro
6. 验证配额生效（free 600s → pro 18000s）
7. 验证"管理订阅" → 跳转 Paddle `management_urls`

## 文件改动总览

```
[删除]  supabase/functions/stripe-webhook/index.ts（整目录）
[新增]  supabase/functions/paddle-webhook/index.ts
[新增]  supabase/functions/_shared/paddle.ts
[新增]  supabase/migrations/0015_migrate_stripe_to_paddle.sql
[重写]  supabase/functions/billing-create-checkout-session/index.ts
[重写]  supabase/functions/billing-create-portal-session/index.ts
[更新]  package.json
[更新]  .env.example
[更新]  supabase/config.toml
[更新]  src/server/config.js
[更新]  src/server/config.test.js
[不变]  前端全部文件（billing.js, app.js, billing.test.js, i18n, style.css）
[不变]  supabase/functions/transcribe/index.ts
[不变]  supabase/functions/_shared/plan_limits.ts, contracts.ts, cors.ts
[不变]  src/shared/planLimits.js
```

**总计**：3 个新增 + 2 个重写 + 5 个更新 + 1 个删除 = **11 个文件有改动**。其余 ~20 个文件完全不动。

## Edge Runtime / Deno 兼容性

Edge Functions 运行在 Deno 中。Paddle Node SDK 通过 `https://esm.sh/@paddle/paddle-node-sdk@2?target=deno` 导入，与当前 Stripe 导入方式（`https://esm.sh/stripe@22.2.0?target=deno&no-dts`）一致。若 SDK 在 Deno 下不兼容，webhook 签名验证可退回手动 HMAC-SHA256 实现（Node `crypto` 模块的标准 API 在 Deno 中可用）。

## 回滚方案

如果 Paddle 迁移后出现阻塞性问题：
1. 恢复 `stripe-webhook` Edge Function（git revert）
2. 恢复 `billing-create-checkout-session` 和 `billing-create-portal-session` 的 Stripe 版本（git revert）
3. 反向执行 migration 0015（`paddle_*` → `stripe_*` 字段名）
4. 恢复 Stripe 环境变量

由于内测期无真实付费用户，回滚风险极低。
