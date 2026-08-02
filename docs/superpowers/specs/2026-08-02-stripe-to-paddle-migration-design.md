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

### 5.2 备选方案：自有 Paddle.js 支付页

增加一个静态 `/pay/` 页面，加载 Paddle.js 并使用 client-side token。后端仍通过 Transaction API 创建交易，返回 `transaction.checkout.url`；支付页仅负责承载 Checkout，不包含业务状态或密钥。

备选方案会增加少量前端文件，但不会改变现有 PWA 的支付入口和后端函数协议。

### 5.3 首次购买不预创建 Address

首次结账时不猜测或硬编码用户国家，也不要求预先创建 Paddle Address。Transaction 可以不传 customer/address，由 Checkout 收集邮箱、国家和邮编。

若 `profiles.provider_customer_id` 已存在，可传入已知 customer ID。若不存在，优先让 Checkout 创建 Customer，再通过 Webhook 回写。只有未来确有服务端预填资料需求时，才增加 Customer/Address 预创建流程。

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
  subscriptions（支付商无关字段）
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
- 数据库字段改为支付商无关命名。
- 支付成功提示改为“正在激活”，并短暂轮询订阅状态。
- Stripe 保留为迁移期回滚通道，稳定后再下线。

## 7. 数据库设计

**新增 migration**：`supabase/migrations/0016_migrate_stripe_to_paddle.sql`

`0015_align_cloud_asr_limits.sql` 已存在，因此不得再使用 `0015`。如果项目继续维护聚合迁移文件，必须同步更新 `supabase/apply_all_migrations.sql`；否则应明确废弃该文件，避免新环境结构漂移。

### 7.1 支付商无关字段

将 Stripe 专属列改成通用列：

```sql
-- profiles
alter table public.profiles
  rename column stripe_customer_id to provider_customer_id;

alter table public.profiles
  add column if not exists billing_provider text;

-- subscriptions
alter table public.subscriptions
  rename column stripe_customer_id to provider_customer_id;
alter table public.subscriptions
  rename column stripe_subscription_id to provider_subscription_id;
alter table public.subscriptions
  rename column stripe_price_id to provider_price_id;

alter table public.subscriptions
  add column if not exists provider text,
  add column if not exists provider_updated_at timestamptz,
  add column if not exists latest_transaction_id text;
```

约束要求：

```sql
alter table public.subscriptions
  add constraint subscriptions_provider_check
  check (provider in ('stripe', 'paddle', 'apple', 'google', 'admin'));

create unique index if not exists subscriptions_provider_subscription_uidx
  on public.subscriptions(provider, provider_subscription_id)
  where provider_subscription_id is not null;
```

迁移现有行时：

- 真实 Stripe 行写入 `provider = 'stripe'`。
- 现有 `admin_<user_id>` 哨兵行写入 `provider = 'admin'`，不得转成 Paddle Customer。
- 管理员权益不能被普通 Paddle Webhook 覆盖。
- `profiles.billing_provider` 只表示该用户当前外部支付提供商，不用于判断管理员权限。

### 7.2 每个用户的当前权益

当前前端按 `user_id` 使用 `.maybeSingle()` 读取订阅，因此必须避免同一用户出现多条可竞争的当前订阅。

本次采用“每个用户最多一条当前权益记录”的简化模型：

```sql
create unique index if not exists subscriptions_user_id_uidx
  on public.subscriptions(user_id);
```

Checkout 创建前必须查询当前权益：

- `active` / `trialing`：拒绝重复购买并引导至 Portal。
- `past_due`：引导更新付款方式，不创建第二份订阅。
- 已计划期末取消但仍在有效期：引导至 Portal。
- `canceled` 且已过期：允许创建新交易。
- `admin`：不允许购买 Pro。

数据库唯一索引负责兜底并发请求；Edge Function 的前置检查只负责友好提示。

### 7.3 billing_events 事件表

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

### 7.4 原子事件处理

新增 service-role 专用数据库 RPC，在一个事务中完成：

1. 根据 `(provider, event_id)` 领取事件。
2. 校验事件是否已处理。
3. 仅当 `event.occurred_at >= subscriptions.provider_updated_at` 时更新订阅。
4. 写入 `provider_updated_at = event.occurred_at`。
5. 标记事件 `processed` / `ignored`。

处理失败时保留事件，并写入 `failed`、`attempt_count` 和 `last_error`，不得删除记录。这样既能让 Paddle 重试，也能审计和人工重放。

## 8. Edge Functions

### 8.1 billing-create-checkout-session（原地重写）

流程：

1. 验证 JWT，取得 user ID 和邮箱。
2. 查询用户当前权益，阻止管理员和已有有效订阅的用户重复购买。
3. 根据 `PADDLE_PRICE_ID` 创建自动收款 Transaction。
4. `customData` 写入 `{ user_id }`。
5. 根据 Checkout 模式返回 Hosted Checkout 或 Default Payment Link URL。
6. 不在此时授予 Pro 权益。

必须校验：

- 当前环境与 Paddle API Key 匹配。
- Price ID 在服务端允许列表中。
- Price 为目标 Pro 循环订阅价格。
- 返回的 Transaction environment 与配置一致。

### 8.2 billing-create-portal-session（原地重写）

流程：

1. 验证 JWT。
2. 查询用户当前 `provider_customer_id`。
3. 确认 `billing_provider = 'paddle'`。
4. 调用 Paddle Customer Portal Session API。
5. 返回通用 Portal URL。

不要把 `subscription.management_urls.update_payment_method` 或 `.cancel` 当成通用 Portal，也不要缓存临时 URL。API Key 必须具备创建 Customer Portal Session 的权限。

### 8.3 paddle-webhook（新增）

流程：

1. 读取未经 JSON 解析的原始请求体。
2. 使用官方 SDK和 `Paddle-Signature` 验签。
3. 校验事件环境、时间和类型。
4. 通过 `(provider, event_id)` 幂等领取事件。
5. 解析并校验 user ID、customer、subscription、price。
6. 按 `occurred_at` 条件更新订阅。
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
| `subscription.updated` | 订阅状态、账期和 scheduled change 的主要权威来源 |
| `subscription.canceled` | 标记取消，保留历史标识 |
| `transaction.completed` | 记录付款、customer 和 transaction ID；不单独推断订阅状态 |
| `transaction.payment_failed` | 记录失败和告警；不直接把订阅写成 `past_due` |
| adjustment/refund 相关事件 | 按退款策略记录并决定是否撤销权益 |

续费失败后的 `past_due`、恢复、暂停等状态，以 Subscription 实体事件为准。不得从任意 Transaction 失败事件直接修改订阅状态。

### 8.5 upsertSubscription 字段映射

```typescript
{
  user_id: userId,
  provider: "paddle",
  provider_customer_id: subscription.customerId,
  provider_subscription_id: subscription.id,
  provider_price_id: validatedPriceId,
  latest_transaction_id: subscription.transactionId ?? null,
  plan: "pro",
  status: mapPaddleStatus(subscription.status),
  current_period_start: subscription.currentBillingPeriod?.startsAt,
  current_period_end: subscription.currentBillingPeriod?.endsAt,
  cancel_at_period_end: subscription.scheduledChange?.action === "cancel",
  provider_updated_at: event.occurredAt,
}
```

不能仅凭 `customData.user_id` 就授予 Pro。至少同时验证：

- `user_id` 是有效 UUID 且用户存在。
- `price_id === PADDLE_PRICE_ID`。
- Price 对应允许的 Pro 循环订阅。
- Customer 与用户现有映射不冲突。
- Webhook 来自当前环境。

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

## 10. 配置

### 10.1 双环境变量

```text
BILLING_PROVIDER=paddle
PADDLE_ENVIRONMENT=sandbox              # sandbox | production
PADDLE_API_KEY=
PADDLE_WEBHOOK_SECRET=
PADDLE_PRICE_ID=
PADDLE_HOSTED_CHECKOUT_URL=             # 主方案
PADDLE_DEFAULT_PAYMENT_LINK=            # 备选方案/回退
PADDLE_CLIENT_TOKEN=                    # 仅 Paddle.js 页面使用，可公开
PADDLE_SUCCESS_URL=https://.../?billing=success
PADDLE_PORTAL_RETURN_URL=https://.../
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
- admin 哨兵记录迁移为 `provider = 'admin'`。
- 同一用户的重复当前订阅被唯一约束阻止。
- `reserve_and_get_plan` 在迁移前后输出一致。
- 聚合迁移文件与增量迁移产生相同 schema。

### 12.2 Checkout

- 未登录返回 401。
- Free 用户获得有效 Checkout URL。
- active/trialing/admin/past_due 用户不会创建第二笔订阅。
- 并发双击只产生一个有效购买流程，或第二个请求得到可恢复提示。
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
- 新事件先到、旧事件后到时，旧事件标记 ignored，不覆盖新状态。
- 处理失败保留 payload/error，重试后可成功。
- 未知 user、错误 price、customer 冲突不会授予 Pro。
- scheduled cancel、past_due、恢复、paused/resumed 均正确。
- 管理员权益不会被 Paddle 事件覆盖。
- 退款、拒付行为符合已确定的权益策略。

### 12.5 Portal 与前端

- Portal Session 返回通用且未过期的 URL。
- 非 Paddle 用户得到清晰提示。
- `?billing=success` 先显示激活中，Webhook 同步后显示成功。
- Webhook 延迟或失败时，前端超时提示正确且不重复扣费。
- Hosted Checkout 的成功、关闭、返回行为在移动端和桌面端验证。

### 12.6 端到端

1. Sandbox 完成购买、续费模拟、付款失败、恢复、计划取消、立即取消和退款。
2. 验证 subscriptions、billing_events 和 profiles 映射。
3. 验证 free 600s → pro 18000s 的配额变化。
4. 验证 Portal 更新付款方式和取消订阅。
5. Production 使用真实小额交易完成一次完整闭环后再切换入口。

## 13. 部署与切换

采用扩展—切换—收缩流程：

1. **扩展**：部署 `0016` 通用字段、事件表、Paddle Functions 和监控；保留 Stripe Functions/secrets。
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
3. Stripe Webhook 继续工作，通用 subscription 字段可以同时容纳 Stripe 数据。
4. 暂停 Paddle 新购买，但继续处理已产生的 Paddle Webhook 和退款。
5. 修复问题后再切回 Paddle。

数据库通用字段和 `billing_events` 不需要回滚。即便重新启用 Stripe，也不得删除已经产生的 Paddle Customer、Transaction 或审计事件。

## 15. 文件改动预估

```text
[新增]  supabase/functions/paddle-webhook/index.ts
[新增]  supabase/functions/_shared/paddle.ts
[新增]  supabase/migrations/0016_migrate_stripe_to_paddle.sql
[新增]  Paddle Webhook / Checkout / migration 测试
[可选]  pay/ 静态支付页（Hosted Checkout 未获批时）
[重写]  supabase/functions/billing-create-checkout-session/index.ts
[重写]  supabase/functions/billing-create-portal-session/index.ts
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
- [Verify webhook signatures](https://developer.paddle.com/webhooks/about/signature-verification/)
- [Respond to webhooks](https://developer.paddle.com/webhooks/about/respond-to-webhooks/)
- [Subscription API and management URLs](https://developer.paddle.com/api-reference/subscriptions/)
- [Paddle Node SDK](https://developer.paddle.com/sdks/libraries/node/)
- [Supabase Edge Function dependencies](https://supabase.com/docs/guides/functions/dependencies)
- [Paddle supported countries](https://www.paddle.com/help/legal/sanctions/which-countries-are-supported-by-paddle)
- [Paddle identity verification](https://www.paddle.com/help/start/account-verification/what-is-identity-verification)
- [Paddle payouts](https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid)
