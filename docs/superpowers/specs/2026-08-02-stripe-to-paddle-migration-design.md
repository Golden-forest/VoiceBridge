# Stripe → Paddle 支付迁移设计

**日期**：2026-08-02

**状态**：已修订，待制定实施计划

**主方案**：Paddle Transaction API + Hosted Checkout（以生产环境审批通过为前提）

**备选方案**：Paddle Transaction API + 自有极简 Paddle.js 支付页

## 1. 背景与动机

VoiceBridge 当前使用 Stripe 完成 Pro 月订阅链路：Checkout → Webhook → 订阅状态同步 → 配额生效。项目所有者位于中国，Paddle 作为 Merchant of Record，可代收全球销售税/VAT，并提供更适合当前主体条件的收款方案。

“Paddle 支持中国商户”不等于账户、网站、Hosted Checkout 和收款渠道一定自动通过。身份验证、网站审核、生产 Hosted Checkout 权限及实际收款验证必须作为迁移前置条件，不能等开发完成后再确认。

## 2. 目标

- 将新购买和订阅管理从 Stripe 切换到 Paddle。
- 保持现有前端支付函数名称和返回协议基本不变。
- 保持 `reserve_and_get_plan` RPC、`transcribe` Edge Function和 free/pro/admin 配额语义不变。
- 使用支付商无关的数据模型，避免未来接入 Apple、Google 或再次更换支付商时重复改表。
- 正确处理 Webhook 重复、乱序、重试和并发。
- 支持安全的灰度切换和快速回滚，不在切换当天删除 Stripe 能力。
- 支付成功后尽快生效，同时不把浏览器跳转误认为订阅已经同步完成。

## 3. 非目标

- 不迁移历史 Stripe 付费用户数据（当前内测期无真实付费用户）。
- 不变更 Pro 套餐定价或配额。
- 不用 Paddle 替代 iOS App Store / Google Play 的原生应用内购买要求。
- 本次不设计多套餐、多币种和优惠码管理后台，但数据结构不应阻碍未来扩展。

## 4. 实施前置条件（Milestone 0）

进入开发前完成：

1. Paddle 账户、身份及业务验证通过。
2. VoiceBridge 官网、隐私政策、服务条款、退款说明满足 Paddle 审核要求。
3. Sandbox 产品和月付 Price 已创建。
4. 生产网站和 Default Payment Link 已审批。
5. 若采用主方案，生产 Hosted Checkout 权限已明确获批。
6. 确认可用的收款路径、结算周期、最低打款门槛及手续费。
7. 明确退款、拒付、全额退款后是否撤销 Pro 权益的业务规则。

若第 5 项未通过，不阻塞迁移，改用备选的自有 Paddle.js 支付页。

## 5. Checkout 方案决策

### 5.1 主方案：Paddle Hosted Checkout

Paddle 服务端没有 `checkouts.create` API。后端必须先调用 Transaction API：

```typescript
const transaction = await paddle.transactions.create({
  items: [{ priceId: env.paddlePriceId, quantity: 1 }],
  collectionMode: "automatic",
  customData: { user_id: userId },
});
```

然后把 Transaction ID 加到已审批的 Hosted Checkout URL：

```typescript
const url = new URL(env.paddleHostedCheckoutUrl);
url.searchParams.set("transaction_id", transaction.id);
return jsonResponse({ ok: true, url: url.toString() });
```

该方案可保持现有 Upgrade 按钮和 `createBillingSession()` 调用协议不变，但生产环境依赖 Paddle 对 Hosted Checkout 的额外审批。

Paddle Billing 的 `customData` 必须是至少包含一个 key 的有效 JSON 对象；官方允许嵌套，但不建议嵌套，因为 Dashboard 可能无法正确展示。VoiceBridge 额外施加更严格的应用级约束：只传扁平的 `{ user_id }`，值为 Supabase UUID，不得嵌入 email、JWT 或其他可变/敏感信息。Webhook 回调时以 `customData.user_id` 为主要关联，Customer 映射反查为兜底。

### 5.2 备选方案：自有 Paddle.js 支付页

增加一个静态 `/pay/` 页面，加载 Paddle.js 并使用 client-side token。后端仍通过 Transaction API 创建交易，返回 `transaction.checkout.url`；支付页仅负责承载 Checkout，不包含业务状态或密钥。

备选方案会增加少量前端文件，但不会改变现有 PWA 的支付入口和后端函数协议。

### 5.3 首次购买不预创建 Address

首次结账时不猜测或硬编码用户国家，也不要求预先创建 Paddle Address。Transaction 可以不传 customer/address，由 Checkout 收集邮箱、国家和邮编。

若 `billing_customers` 中已存在该用户的 Paddle Customer，可传入已知 Customer ID。若不存在，优先让 Checkout 创建 Customer，再通过 Webhook 回写。只有未来确有服务端预填资料需求时，才增加 Customer/Address 预创建流程。

## 6. 整体架构

```text
[PWA]
  Upgrade / Manage
       │
       ▼
[Supabase Edge Functions]
  billing-create-checkout-session ──→ Paddle transactions.create
  billing-create-portal-session   ──→ Paddle customer portal session
  paddle-webhook                  ←── Paddle webhook events
       │
       ▼
[PostgreSQL]
  profiles
  billing_customers（每个支付商的 Customer 映射）
  provider_subscriptions（支付商订阅事实与历史）
  subscriptions（每个用户当前权益，保持前端/RPC兼容）
  billing_checkout_attempts（Checkout 并发控制）
  billing_events（幂等、乱序控制、审计）
  reserve_and_get_plan（不变）
```

### 保持不变

- `reserve_and_get_plan` RPC 和 ASR 配额执行链路。
- `transcribe` Edge Function。
- free/pro/admin 套餐语义和配额。
- 前端 `createBillingSession()` 的调用签名和 Edge Function 路径。

### 需要替换或调整

- Checkout Edge Function 内部实现。
- Portal Edge Function 内部实现。
- 新增 Paddle Webhook。
- 新增支付商无关的 Customer、Subscription 事实表和当前权益投影。
- 支付成功提示改为“正在激活”，并短暂轮询订阅状态。
- Stripe 保留为迁移期回滚通道，稳定后再下线。

## 7. 数据库设计

**新增 migration**：`supabase/migrations/0016_migrate_stripe_to_paddle.sql`

`0015_align_cloud_asr_limits.sql` 已存在，因此不得再使用 `0015`。如果项目继续维护聚合迁移文件，必须同步更新 `supabase/apply_all_migrations.sql`；否则应明确废弃该文件，避免新环境结构漂移。

### 7.1 Customer 映射与支付商订阅事实

不能把 Stripe 和 Paddle Customer ID 轮流写入 `profiles` 的同一列，否则切换或回滚会丢失另一支付商的映射。本次新增独立映射表：

```sql
create table public.billing_customers (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null
    check (provider in ('stripe', 'paddle', 'apple', 'google')),
  provider_customer_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  unique (provider, provider_customer_id),
  unique (user_id, provider, provider_customer_id)
);

create table public.provider_subscriptions (
  provider text not null
    check (provider in ('stripe', 'paddle', 'apple', 'google')),
  provider_subscription_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_customer_id text not null,
  provider_price_id text,
  plan text not null default 'pro',
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  subscription_state_occurred_at timestamptz,
  latest_transaction_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, provider_subscription_id),
  foreign key (user_id, provider, provider_customer_id)
    references public.billing_customers(user_id, provider, provider_customer_id)
);
```

`subscription_state_occurred_at` 只用于同一 Provider Subscription 的 `subscription.*` 状态乱序控制。Transaction 和 Adjustment 事件不得推进该时间水位。

迁移现有数据时：

- 将 `profiles.stripe_customer_id` 和真实 Stripe 订阅回填到上述两张表。
- 迁移窗口内保留旧 Stripe 列，先让 Stripe Webhook 改为双写；Paddle 稳定且 Stripe 收缩完成后再单独 migration 删除旧列。
- 旧 `subscriptions.stripe_*` 列仅供迁移期 Stripe 兼容代码使用；通用权益查询和 Paddle 写入不得依赖或覆盖这些列。
- 现有 `admin_<user_id>` 哨兵不是外部 Customer 或 Subscription，不写入上述两表。
- 两张新表启用 RLS，客户端无访问策略，仅 `service_role` 使用。

### 7.2 每个用户的当前权益

现有 `subscriptions` 表继续作为“每个用户当前权益”的兼容投影，以保持前端 `.maybeSingle()`、`reserve_and_get_plan` 和配额链路不变。为其增加权益来源字段：

```sql
alter table public.subscriptions
  add column if not exists source_provider text,
  add column if not exists source_subscription_id text,
  add column if not exists entitlement_updated_at timestamptz;

alter table public.subscriptions
  add constraint subscriptions_source_provider_check
  check (source_provider in ('stripe', 'paddle', 'apple', 'google', 'admin'));

update public.subscriptions
set source_provider = case
      when plan = 'admin' or stripe_customer_id like 'admin_%' then 'admin'
      else 'stripe'
    end,
    source_subscription_id = stripe_subscription_id,
    entitlement_updated_at = coalesce(updated_at, now())
where source_provider is null;

alter table public.subscriptions
  alter column source_provider set not null,
  alter column stripe_customer_id drop not null;

create unique index if not exists subscriptions_user_id_uidx
  on public.subscriptions(user_id);
```

规则：

- `provider_subscriptions` 保存各支付商的事实和历史；`subscriptions` 只保存当前生效权益。
- `active` / `trialing` 的当前权益不能被另一支付商的 Webhook 覆盖。
- `admin` 权益不能被任何外部支付 Webhook 覆盖。
- 同来源订阅的较新 `subscription.*` 事件可以更新当前权益。
- 当前权益已取消/过期后，新支付商只有在存在与用户匹配的成功 Checkout/Transaction 证据时才能接管权益。
- Portal 根据 `subscriptions.source_provider` 路由，因此回滚 Stripe Checkout 后，既有 Paddle 用户仍进入 Paddle Portal。

Checkout 创建前查询当前权益：`active` / `trialing`、`past_due`、计划期末取消但仍有效以及 `admin` 均不创建第二份订阅；只有已取消且过期或无当前权益的用户可以购买。

### 7.3 Checkout 并发控制

订阅唯一索引要等 Webhook 落库后才生效，不能阻止并发请求创建两笔外部 Transaction。新增 Checkout attempt 表：

```sql
create table public.billing_checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('stripe', 'paddle')),
  status text not null
    check (status in ('creating', 'open', 'completed', 'failed', 'expired')),
  provider_transaction_id text,
  checkout_url text,
  last_error text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index billing_checkout_attempts_one_open_uidx
  on public.billing_checkout_attempts(user_id)
  where status in ('creating', 'open');

alter table public.billing_checkout_attempts enable row level security;
```

客户端无访问策略，仅 `service_role` 使用。新增 service-role RPC 原子创建或取得当前 attempt；唯一索引跨支付商生效，避免切换窗口内同时存在 Stripe 和 Paddle Checkout。只有成功领取 `creating` 的请求可以调用 Paddle；并发请求返回已有 `open` URL，或在首个请求仍为 `creating` 时返回“正在创建，请稍后重试”。外部 API 成功后保存 Transaction ID/URL 并改为 `open`；失败改为 `failed`，支付完成后由 Webhook 改为 `completed`。

`creating` 必须有短 lease，避免函数崩溃后永久阻塞。`open` attempt 不能仅因本地 `expires_at` 到期就释放唯一锁，因为已签发的外部 Checkout URL 可能仍可付款；必须先查询并确认外部 Transaction 已完成/取消，或调用支付商 API 成功取消仍可支付的 Transaction，才能把 attempt 改为 `expired` 并允许创建另一笔购买流程。

### 7.4 billing_events 事件表

使用通用事件表，而不是新增 Paddle 专属表：

```sql
create table if not exists public.billing_events (
  provider text not null,
  event_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  status text not null default 'received'
    check (status in ('received', 'processed', 'failed', 'ignored')),
  attempt_count integer not null default 0,
  user_id uuid references auth.users(id) on delete set null,
  provider_subscription_id text,
  payload jsonb,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (provider, event_id)
);

alter table public.billing_events enable row level security;
```

客户端无访问策略，仅 `service_role` 使用。旧 `stripe_events` 保留存档，不在本次迁移删除。

### 7.5 原子事件处理

Webhook Function 先完成验签、UUID/用户、Price allowlist、Customer 冲突和事件类型校验，再把原始审计字段与标准化后的持久化 effect 传给 service-role 专用 RPC；永久校验失败则传入只记录审计、不授予权益的 ignored/failed effect。RPC 在一个数据库事务中完成：

1. 插入 `billing_events`；冲突时 `select ... for update` 锁定同一事件。
2. 已为 `processed` / `ignored` 时返回 `duplicate`。
3. 从已校验 effect 原子 upsert `billing_customers`，因此即使 `customer.created` 尚未到达也能处理 Subscription 快照。
4. Subscription 事件仅在 `occurred_at >= subscription_state_occurred_at` 时更新对应 `provider_subscriptions`。
5. Transaction 事件只更新付款审计和 `latest_transaction_id`，不推进 Subscription 状态水位。
6. `subscription.created` / `transaction.completed` 用匹配的 Transaction ID 完成 `billing_checkout_attempts`。
7. 按 §7.2 的来源优先级投影当前 `subscriptions` 权益。
8. 在同一事务内标记事件为 `processed` / `ignored`。

处理失败时保留事件，并写入 `failed`、`attempt_count` 和 `last_error`，不得删除记录。这样既能让 Paddle 重试，也能审计和人工重放。

RPC 接收完整审计字段和经过 Edge Function 校验的标准化 effect。具体 effect 类型在实施时用 TypeScript discriminated union 和 SQL 校验固定，不接受任意表名或任意 SQL 字段：

```sql
create or replace function public.process_billing_event(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_effect jsonb
) returns table(action text)   -- 'processed' | 'duplicate' | 'stale' | 'failed'
language plpgsql
security definer
set search_path = ''
as $$
  -- 插入/锁定事件；校验固定 effect schema；条件更新 provider subscription；
  -- 投影当前 entitlement；最后更新事件状态。实现需包含并发与异常测试。
$$;

grant execute on function public.process_billing_event(text, text, text, timestamptz, jsonb, jsonb)
  to service_role;
revoke execute on function public.process_billing_event(text, text, text, timestamptz, jsonb, jsonb)
  from public, anon, authenticated;
```

RPC 内部捕获可记录的持久化异常，将事件写为 `failed`、增加 `attempt_count` 并返回 `failed`；Webhook 随后返回非 2xx 触发 Paddle 重试。若数据库整体不可用而无法记录，则直接返回非 2xx。永久业务校验错误通过同一个 RPC 记录为 `ignored` 或 `failed` 并告警，避免无限重试。不得依赖 Edge Function 中分离的 `upsert().gte()` 链来实现原子条件更新。

## 8. Edge Functions

### 8.1 billing-create-checkout-session（原地重写）

流程：

1. 验证 JWT，取得 user ID 和邮箱。
2. 查询用户当前权益，阻止管理员和已有有效订阅的用户重复购买。
3. 通过数据库 RPC 原子领取或恢复 `billing_checkout_attempts`。
4. 只有 attempt 领取者根据 `PADDLE_PRICE_ID` 创建自动收款 Transaction。
5. `customData` 写入 `{ user_id }`。
6. 保存 Transaction ID 和 Checkout URL，将 attempt 改为 `open`。
7. 根据 Checkout 模式返回 Hosted Checkout 或 Default Payment Link URL。
8. 不在此时授予 Pro 权益。

必须校验：

- 当前环境与 Paddle API Key 匹配。
- Price ID 在服务端允许列表中。
- Price 为目标 Pro 循环订阅价格。
- Sandbox/Production 使用不同的 API base URL、API Key、Price allowlist 和 Checkout URL。Paddle Transaction 实体没有可供业务代码校验的 `environment` 字段，不得假定存在该字段。

### 8.2 billing-create-portal-session（原地重写）

流程：

1. 验证 JWT。
2. 查询当前权益的 `source_provider` 和 `source_subscription_id`。
3. 从 `billing_customers` 查询该 Provider 的 Customer ID。
4. 若来源为 Paddle，调用 Customer Portal Session API；若来源为 Stripe，调用保留的 Stripe Portal 实现。
5. 返回对应支付商的通用 Portal URL。

Paddle Customer Portal Session API 已正式发布。锁定的 Node SDK 3.8.0 使用：

```typescript
const session = await paddle.customerPortalSessions.create(
  customerId,
  providerSubscriptionId ? [providerSubscriptionId] : undefined,
);
return jsonResponse({ ok: true, url: session.urls.general.overview });
```

Portal Session 不接收 `return_url`。返回的认证 URL 是临时链接，不得缓存，也不得嵌入 iframe。API Key 必须具备 `customer_portal_session.write` 权限。`subscription.management_urls` 仅作为产品降级方案，不是 SDK preview 兼容路径；若启用，必须在实现与测试中明确选择具体的更新付款或取消链接，不能把二者当成通用 Portal 首页。

### 8.3 paddle-webhook（新增）

流程：

1. 读取未经 JSON 解析的原始请求体。
2. 使用官方 SDK和 `Paddle-Signature` 验签。
3. 校验事件时间和类型；环境由独立 API base URL、Webhook destination 和 secret 隔离，不读取不存在的 payload `environment` 字段。
4. 解析并校验 user ID、Customer、Subscription、Price，构造固定类型的 effect。
5. 调用 `process_billing_event` 原子完成幂等、乱序控制、支付商事实更新和当前权益投影。
6. 按 RPC action 决定 2xx、告警或可重试错误。
7. 在 5 秒内返回 2xx；较慢的补充任务可使用 Edge Runtime 后台任务。

签名验证优先使用 SDK `webhooks.unmarshal()`。如果确需手写 fallback，必须：

- 对原始 body 做 HMAC，不得对重新序列化的 JSON 验签。
- 使用 timing-safe compare。
- 支持密钥轮换时同一 header 中多个 `h1`。
- 使用可配置的 timestamp tolerance，默认跟随官方 SDK。

### 8.4 订阅事件权威来源

| Paddle 事件 | 处理策略 |
|---|---|
| `subscription.created` | 创建/更新当前订阅，校验 price 和 user ID |
| `subscription.updated` | 状态、账期和 scheduled change 的主要权威来源 |
| `subscription.activated/trialing/past_due/paused/resumed/canceled` | 按完整 Subscription 快照处理；与 updated 共用同一状态水位 |
| `transaction.completed` | 记录付款、Customer 和 Transaction ID；不推进 Subscription 状态水位，不单独推断订阅状态 |
| `transaction.payment_failed` | 记录失败和告警；不直接把订阅写成 `past_due` |
| adjustment/refund 相关事件 | 按退款策略记录并决定是否撤销权益 |

续费失败后的 `past_due`、恢复、暂停等状态，以 Subscription 实体事件为准。不得从任意 Transaction 失败事件直接修改订阅状态。所有 `subscription.*` 处理器复用同一份字段验证和映射逻辑。

### 8.5 upsertSubscription 字段映射

```typescript
{
  user_id: userId,
  provider: "paddle",
  provider_customer_id: subscription.customerId,
  provider_subscription_id: subscription.id,
  provider_price_id: validatedPriceId,
  plan: "pro",
  status: mapPaddleStatus(subscription.status),
  current_period_start: subscription.currentBillingPeriod?.startsAt,
  current_period_end: subscription.currentBillingPeriod?.endsAt,
  cancel_at_period_end: subscription.scheduledChange?.action === "cancel",
  subscription_state_occurred_at: event.occurredAt,
}
```

`transactionId` 只在 `subscription.created` Webhook 中额外提供，其他 Subscription 事件通常没有。仅当字段实际存在时才更新 `latest_transaction_id`，不得用 `?? null` 清空已有值。续费等后续付款由 `transaction.completed.data.subscriptionId` 定位 `provider_subscriptions` 并更新 `latest_transaction_id`，但不改 `subscription_state_occurred_at`。

不能仅凭 `customData.user_id` 就授予 Pro。至少同时验证：

- `user_id` 是有效 UUID 且用户存在。
- `price_id === PADDLE_PRICE_ID`。
- Price 对应允许的 Pro 循环订阅。
- Customer 与用户现有映射不冲突。
- Webhook 使用当前环境独立配置的 destination 和 secret 验签通过。

`customData` 写在 Transaction 上，Paddle 会将其复制到相关 Subscription，可作为 user ID 的主要关联方式；customer ID 反查仅作为恢复路径。

### 8.6 Paddle 状态映射

| Paddle status | DB status | 当前提供 Pro 配额 |
|---|---|---|
| `active` | `active` | 是 |
| `trialing` | `trialing` | 是 |
| `paused` | `paused` | 否 |
| `past_due` | `past_due` | 否 |
| `canceled` | `canceled` | 否 |

保持现有 `reserve_and_get_plan` 对 active/trialing/admin 的判断不变。

### 8.7 _shared/paddle.ts（新增）

提供：

- `createPaddle(apiKey, environment)`
- `getBillingEnv()` 和启动时配置校验
- `mapPaddleStatus(status)`
- `validatePaddlePrice(items, allowedPriceId)`
- `resolveUserId(serviceClient, customData, customerId)`
- Checkout URL 构造

## 9. 前端改动

支付入口保持不变，但成功状态需要做最小调整，不能继续把 `?billing=success` 直接当作 Pro 已经激活。

### 保持不变

- `createBillingSession()` 函数签名。
- `/functions/v1/billing-create-checkout-session` 路径。
- Upgrade 和 Manage subscription 按钮布局。
- `billing.js` 的基本请求/跳转封装。

### 最小必要改动

- 收到 `?billing=success` 后显示“Payment received. Activating Pro…”而不是“Subscription active”。
- 轮询/重新拉取订阅状态，确认 `active` 或 `trialing` 后再显示激活成功。
- 设置合理超时；超时提示用户稍后刷新，不重复创建 Checkout。
- 对中英文文案同步更新。
- 主方案下确认 Hosted Checkout 的成功和关闭行为；不能未经验证就假设 `?billing=cancel` 一定回跳。

如果使用 Paddle.js 备选方案，再增加 `/pay/` 静态页和公开 client-side token；任何 API Key 或 Webhook secret 都不得进入前端。

前端不感知 `BILLING_PROVIDER` 的值，两个 Edge Function 继续使用原路径：Checkout Function 读取全局开关决定“新购买”走 Stripe 还是 Paddle；Portal Function 必须根据用户当前权益的 `source_provider` 路由，使回滚期间既有 Paddle 用户仍能管理 Paddle 订阅。这样切换新购买入口时不需要重新部署前端，也不会把存量用户送到错误的 Portal。

## 10. 配置

### 10.1 双环境变量

```text
BILLING_PROVIDER=paddle                   # stripe | paddle，只决定新 Checkout；Portal 按用户权益来源路由
PADDLE_ENVIRONMENT=sandbox              # sandbox | production
PADDLE_API_KEY=
PADDLE_WEBHOOK_SECRET=
PADDLE_PRICE_ID=
PADDLE_HOSTED_CHECKOUT_URL=             # 主方案
PADDLE_DEFAULT_PAYMENT_LINK=            # 备选方案/回退
PADDLE_CLIENT_TOKEN=                    # 仅 Paddle.js 页面使用，可公开
PADDLE_SUCCESS_URL=https://.../?billing=success
```

Sandbox 与 Production 的 API Key、Price ID、Webhook secret、client token 和 Checkout URL 完全分开。函数启动时必须 fail fast，避免 Sandbox key 配 Production price。

迁移窗口内保留全部 Stripe secrets，待 Paddle 稳定后再清理。

### 10.2 Supabase 配置

```toml
[functions.paddle-webhook]
verify_jwt = false

[functions.billing-create-checkout-session]
verify_jwt = true

[functions.billing-create-portal-session]
verify_jwt = true
```

### 10.3 SDK 与依赖

Edge Function 使用固定版本的官方 SDK和 Supabase 推荐的 `npm:` 导入方式，例如：

```typescript
import { Paddle } from "npm:@paddle/paddle-node-sdk@3.8.0";
```

具体版本在实施时以已验证的最新稳定版本为准，但必须精确锁定，不使用 `^`、`@2` 或浮动 esm.sh URL。字段按 SDK 的 camelCase 类型使用。

如果根 Node 应用不直接调用 Paddle SDK，则不必在根 `package.json` 重复安装；Edge Function 依赖放入对应 `deno.json` / lockfile。上线前必须进行本地、Supabase preview 和生产构建兼容性验证。

## 11. Webhook 响应与恢复策略

- 验签失败：返回 400/401，记录不含敏感信息的安全日志。
- 已处理事件：立即返回 200。
- 不支持的事件：写为 `ignored`，返回 200。
- 暂时性数据库/API 错误：记录失败并返回非 2xx，让 Paddle 重试。
- 永久数据错误（未知 user、错误 price、环境不符）：写入 failed/ignored 并告警，避免无限重试风暴。
- 定期运行对账任务，比较 Paddle Subscription 与本地当前权益，修复漏掉或长期失败的事件。

监控指标至少包括：

- Webhook 验签失败数。
- 处理耗时和非 2xx 比例。
- `failed` 事件数量及最老等待时间。
- 未解析 user ID / customer 冲突数。
- Checkout 创建失败和重复购买拦截数。
- Paddle 与本地订阅状态不一致数。

## 12. 测试策略

### 12.1 数据库与迁移

- `0016` 可在当前数据库顺序执行。
- Stripe Customer/Subscription 正确回填到 `billing_customers` 和 `provider_subscriptions`。
- admin 哨兵仅保留为当前权益，不进入外部支付商事实表。
- 同一用户、同一支付商只存在一条 Customer 映射，同一外部 Subscription 只能归属一个用户。
- `subscriptions` 每用户最多一条当前权益，active/admin 来源不会被另一支付商事件覆盖。
- 同一用户跨支付商最多只有一个 `creating/open` Checkout attempt。
- `reserve_and_get_plan` 在迁移前后输出一致。
- 聚合迁移文件与增量迁移产生相同 schema。

### 12.2 Checkout

- 未登录返回 401。
- Free 用户获得有效 Checkout URL。
- active/trialing/admin/past_due 用户不会创建第二笔订阅。
- 并发双击只允许一个请求领取 `creating` attempt，只产生一个 Paddle Transaction；第二个请求返回已有 URL 或可恢复提示。
- `creating` 请求崩溃后可在 lease 过期时安全恢复，不会永久阻塞。
- `open` attempt 到期但外部 Transaction 仍可支付时不会释放锁；确认或取消外部 Transaction 后才允许新 Checkout。
- 错误 Price、环境不匹配、Paddle API 超时均安全失败。
- 首次购买不要求本地 country/address。

### 12.3 Webhook 签名

- 有效签名通过。
- 无效或缺失签名拒绝。
- 原始 body 与重新序列化 body 的差异不会被忽略。
- 超出 tolerance 的 timestamp 拒绝。
- 多个 `h1` 中任一有效签名可通过。

### 12.4 Webhook 状态

- created / updated / canceled 正确映射。
- `transaction.payment_failed` 不直接修改订阅状态。
- 重复 event ID 幂等跳过。
- 相同事件并发投递只处理一次。
- 同一 Provider Subscription 的新状态事件先到、旧状态事件后到时，旧事件标记 ignored，不覆盖新状态。
- `transaction.completed` 先到、`subscription.created` 后到时，Subscription 不会因 Transaction 时间水位而被误判 stale。
- `subscription.created` 在 `customer.created` 之前到达时，仍可从完整快照原子建立 Customer 映射和订阅事实。
- `subscription.updated` 不含 transaction ID 时不会清空已有 `latest_transaction_id`。
- 处理失败保留 payload/error，重试后可成功。
- 未知 user、错误 price、customer 冲突不会授予 Pro。
- scheduled cancel、past_due、恢复、paused/resumed 均正确。
- 管理员权益不会被 Paddle 事件覆盖。
- 退款、拒付行为符合已确定的权益策略。

### 12.5 Portal 与前端

- Paddle Portal Session 返回 `urls.general.overview` 临时 URL，且不缓存。
- 非 Paddle 用户得到清晰提示。
- 回滚期间 Stripe 用户进入 Stripe Portal，Paddle 用户仍进入 Paddle Portal。
- `?billing=success` 先显示激活中，Webhook 同步后显示成功。
- Webhook 延迟或失败时，前端超时提示正确且不重复扣费。
- Hosted Checkout 的成功、关闭、返回行为在移动端和桌面端验证。

### 12.6 端到端

1. Sandbox 完成购买、续费模拟、付款失败、恢复、计划取消、立即取消和退款。
2. 验证 billing_customers、provider_subscriptions、subscriptions、billing_checkout_attempts 和 billing_events 映射。
3. 验证 free 600s → pro 18000s 的配额变化。
4. 验证 Portal 更新付款方式和取消订阅。
5. Production 使用真实小额交易完成一次完整闭环后再切换入口。

## 13. 部署与切换

采用扩展—切换—收缩流程：

1. **扩展**：部署 `0016` Customer/Provider Subscription/Checkout attempt/事件表、Paddle Functions 和监控；保留 Stripe Functions/secrets，并让 Stripe Webhook 双写新表。
2. **Sandbox 验证**：完成完整 E2E 和乱序/重试测试。
3. **Production 冒烟**：真实小额购买、Portal、取消和退款验证。
4. **切换**：将 `BILLING_PROVIDER` 从 `stripe` 改为 `paddle`，只切换新 Checkout。
5. **观察**：至少保留 Stripe Webhook 和 secrets 7～30 天，处理潜在旧事件和退款。
6. **收缩**：确认无 Stripe 活跃订阅和待处理事件后，再删除 Stripe Functions、依赖和 secrets。

不得在首次 Paddle 部署时执行 `supabase secrets unset STRIPE_*`，也不得同时删除 Stripe Webhook。

## 14. 回滚方案

迁移通过支付商开关回滚，不反向重命名数据库列：

1. 将 `BILLING_PROVIDER=stripe`。
2. 重新部署或启用保留的 Stripe Checkout/Portal Function 实现。
3. Stripe Webhook 继续写入独立的 Stripe Customer/Provider Subscription 记录；当前权益按来源优先级投影。
4. 暂停 Paddle 新购买，但继续处理已产生的 Paddle Webhook 和退款。
5. 修复问题后再切回 Paddle。

`billing_customers`、`provider_subscriptions`、`billing_checkout_attempts` 和 `billing_events` 不需要回滚。即便重新启用 Stripe，也不得删除已经产生的 Paddle Customer、Subscription、Transaction 或审计事件。回滚只影响新 Checkout；既有 Paddle 用户的 Portal 和 Webhook 必须继续工作。

## 15. 文件改动预估

```text
[新增]  supabase/functions/paddle-webhook/index.ts
[新增]  supabase/functions/_shared/paddle.ts
[新增]  supabase/migrations/0016_migrate_stripe_to_paddle.sql
[新增]  Paddle Webhook / Checkout / migration 测试
[可选]  pay/ 静态支付页（Hosted Checkout 未获批时）
[重写]  supabase/functions/billing-create-checkout-session/index.ts
[重写]  supabase/functions/billing-create-portal-session/index.ts
[更新]  supabase/functions/stripe-webhook/index.ts（迁移期双写新支付事实表）
[更新]  src/public/app.js 与 hosted-pwa 镜像（激活中/轮询）
[更新]  i18n 中英文支付状态文案
[更新]  .env.example
[更新]  supabase/config.toml
[更新]  Edge Function deno.json / lockfile
[更新]  src/server/config.js 与测试（如仍由该层读取支付配置）
[更新]  supabase/apply_all_migrations.sql（若继续使用）
[暂留]  stripe-webhook 与 Stripe secrets（观察期后删除）
[不变]  supabase/functions/transcribe/index.ts
[不变]  reserve_and_get_plan 与共享配额常量
```

实施计划必须以实际代码引用搜索为准，不根据此清单直接假定每个配置文件都仍在使用。

## 16. 官方参考

- [Paddle Create transaction API](https://developer.paddle.com/api-reference/transactions/create-transaction/)
- [Create a transaction](https://developer.paddle.com/build/transactions/create-transaction/)
- [Hosted Checkout](https://developer.paddle.com/paddle-js/about/hosted-checkout/)
- [Default Payment Link](https://developer.paddle.com/build/transactions/default-payment-link/)
- [Handle checkout success](https://developer.paddle.com/build/checkout/handle-success-post-checkout/)
- [Work with custom data](https://developer.paddle.com/build/transactions/custom-data/)
- [How Paddle webhooks work](https://developer.paddle.com/webhooks/about/how-webhooks-work/)
- [Verify webhook signatures](https://developer.paddle.com/webhooks/about/signature-verification/)
- [Respond to webhooks](https://developer.paddle.com/webhooks/about/respond-to-webhooks/)
- [Create a Customer Portal Session](https://developer.paddle.com/api-reference/customer-portals/create-customer-portal-session/)
- [Use Customer Portal links](https://developer.paddle.com/build/customers/integrate-customer-portal/)
- [subscription.created Webhook](https://developer.paddle.com/webhooks/subscriptions/subscription-created/)
- [transaction.completed Webhook](https://developer.paddle.com/webhooks/transactions/transaction-completed/)
- [Subscription API and management URLs](https://developer.paddle.com/api-reference/subscriptions/)
- [Paddle Node SDK](https://developer.paddle.com/sdks/libraries/node/)
- [Supabase Edge Function dependencies](https://supabase.com/docs/guides/functions/dependencies)
- [Paddle supported countries](https://www.paddle.com/help/legal/sanctions/which-countries-are-supported-by-paddle)
- [Paddle identity verification](https://www.paddle.com/help/start/account-verification/what-is-identity-verification)
- [Paddle payouts](https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid)
