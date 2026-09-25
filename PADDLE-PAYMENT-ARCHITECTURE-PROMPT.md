# Paddle + Supabase 订阅支付架构参考提示词

> 用途：把这份文档作为"参考说明书"喂给 AI 助手（Claude Code / Cursor / 其他），指导它在**另一个项目**里复刻一套架构等价、但凭证隔离的 Paddle 订阅支付系统。所有引用的文件路径都是 VoiceBridge 项目里的**真实文件**，AI 助手可以打开阅读以获取完整上下文。

---

## 一、你的任务

我要在新项目里搭建一套**与 VoiceBridge 架构等价**的 Paddle 订阅支付系统。技术栈保持一致：

- **前端**：静态 JS（无框架），通过 Cloudflare Pages / Supabase Hosting 部署
- **后端**：Supabase Postgres + Auth + Edge Functions（Deno）
- **支付**：Paddle（Merchant of Record），SDK 版本锁定 `npm:@paddle/paddle-node-sdk@3.8.0`
- **权益管理**：通过 `subscriptions` 表统一投影，业务代码只读这张表

**请严格按本文档引用的设计模式实现**。VoiceBridge 的源码是经过多轮修订（0016/0017/0018/0019/0020 + 20260804/20260805 迁移）才稳定下来的，不要重新发明轮子。

---

## 二、核心设计原则（不可妥协）

1. **支付商无关的数据模型**：所有支付事实表都带 `provider` 字段（`stripe/paddle/apple/google`），换支付商不改表结构。
2. **Webhook 是唯一真相源**：前端跳转不算订阅生效，只有 Webhook 落库后权益才更新。
3. **原子事件处理**：所有 Webhook 事件经单一 RPC `process_billing_event` 处理，在一个 Postgres 事务内完成幂等领取 → upsert → 权益投影。
4. **乱序控制**：订阅状态更新通过 `subscription_state_occurred_at` 字段做水位线，旧事件不能覆盖新状态。
5. **凭证隔离**：所有 Paddle/Stripe 凭证通过 `supabase secrets set` 注入，绝不进 `.env` / git / 前端。前端只允许出现**设计上可公开**的 `PADDLE_CLIENT_TOKEN`（`live_` 前缀）和 `SUPABASE_ANON_KEY`。
6. **Webhook 双层验证**：IP allowlist（动态拉取 `api.paddle.com/ips`）+ 签名验签，缺一不可。IP 拉取失败必须 fail-closed（返回 503 让 Paddle 重试），不能 fail-open。
7. **强制 production 环境**：本构建不支持 sandbox。`PADDLE_ENVIRONMENT` 必须是 `production`，前端 `paddleClientToken` 必须以 `live_` 开头，否则部署脚本拒绝部署。
8. **不做 Cart 抽象**：只支持单一 Pro 月订阅，但 schema 不阻碍未来扩展多套餐。

---

## 三、必读参考文件清单

实施前**必须逐个通读**以下文件，理解每个设计决策的"为什么"：

### 3.1 设计文档（Why 层）

| 文件 | 重点 |
|---|---|
| `docs/superpowers/specs/2026-08-02-stripe-to-paddle-migration-design.md` | **核心设计文档**（672 行）。第 1-3 节讲动机和目标；第 4 节是前置条件清单（Paddle 审核、Hosted Checkout 权限）；第 5 节是 Checkout 方案选型（Hosted Checkout 主方案 vs Paddle.js overlay 备选）；第 477-487 行列全部环境变量；第 601-624 行是部署切换流程，含回滚方案 |
| `CLAUDE.md`（项目根） | 第 21-34 行是 Paddle 集成规范的精简版，列出 SDK 版本、验签、secrets 管理、Price 校验五条铁律 |

### 3.2 数据库迁移（Schema 层）

| 文件 | 作用 | 关键行 |
|---|---|---|
| `supabase/migrations/0016_migrate_stripe_to_paddle.sql` | **核心迁移**。创建 4 张支付商无关表 + 3 个 RPC。请通读全文件 | L10-20 `billing_customers`（user×provider×customer_id 映射）；L27-46 `provider_subscriptions`（订阅事实表，含 `subscription_state_occurred_at` 水位线字段）；L53-72 `billing_checkout_attempts`（结账并发控制，含 `creating/open/completed/failed/expired` 状态机）；L77-94 `billing_events`（通用事件表，主键 `(provider, event_id)` 幂等）；L178-398 `process_billing_event` RPC；L404-456 `claim_checkout_attempt` RPC（含 30 秒 lease）；L466-491 `update_checkout_attempt` RPC |
| `supabase/migrations/20260804042520_fix_billing_event_effect_contract.sql` | **RPC 重写版**。原 0016 版本 effect.type 比较错误（把 `subscription/transaction/ignore` 和 Paddle 事件名 `subscription.created` 比较），这是修订后的正确实现 | L9-224 重写的 `process_billing_event`，注意 L41-45 的 UUID 正则防御性解析、L233-295 的历史事件重放逻辑 |
| `supabase/migrations/20260805050100_add_billing_fk_indexes.sql` | 给 `provider_subscriptions.user_id`、`billing_events.user_id`、`billing_checkout_attempts.user_id` 加索引，加速 CASCADE 删除 | 整个文件很短，直接复用 |

**重要**：实现时**不要**直接复制 0016 的 `process_billing_event`，要用 `20260804042520` 的重写版本。0016 版本有 bug。

### 3.3 Edge Function 代码（实现层）

| 文件 | 作用 | 关键点 |
|---|---|---|
| `supabase/functions/_shared/paddle.ts` | **共享工具模块**，被所有支付相关函数依赖 | L22-30 `requireEnv`/`optionalEnv` fail fast 模式；L37-43 强制 production 环境；L62-93 Paddle IP allowlist 带 15 分钟 TTL 缓存；L99-112 从 `CF-Connecting-IP` / `X-Forwarded-For` 提真实 IP；L117-138 `getBillingEnv()` 配置入口；L143-145 `createPaddle()`；L151-166 `mapPaddleStatus()`；L171-177 `validatePaddlePrice()`；L185-210 `resolveUserId()`（customData 优先，billing_customers 反查兜底） |
| `supabase/functions/paddle-webhook/index.ts` | **Paddle Webhook 处理器**（248 行）。这是整个系统最关键的代码 | L20-118 主流程：L39-51 IP allowlist 失败必须 503；L54-62 验签必须读**原始 body**，JSON 解析前调 `unmarshal`；L90-100 调用 `process_billing_event` RPC；L108-111 RPC 失败返回 500 让 Paddle 重试；L124-137 `BillingEffect` interface；L139-159 `buildEffect` 事件路由；L161-202 subscription 事件构造；L204-247 transaction 事件构造 |
| `supabase/functions/billing-create-checkout-session/index.ts` | **创建结账会话**（258 行） | L44-47 唯一的 `BILLING_PROVIDER` 路由分发点；L57-132 `handlePaddleCheckout`：L69-78 调用 `claim_checkout_attempt`（原子领取或创建新 attempt）；L94-99 创建 Transaction 时 `customData: { user_id: userId }` 是关键（Webhook 反查用户的依据）；L100-108 失败时更新 attempt 状态；L122-128 成功时更新 attempt 为 open |
| `supabase/functions/billing-create-portal-session/index.ts` | **客户门户跳转** | 不直接读 `BILLING_PROVIDER`，而是按 `subscriptions.source_provider` 路由。这保证切换期间已有 Paddle 用户继续走 Paddle Portal，新用户走新支付商 |
| `supabase/functions/billing-get-client-context/index.ts` | 返回 Paddle Customer ID 给前端 Paddle Retain | 通过 Paddle API 反向校验 ID 有效性 |
| `supabase/functions/account-delete/index.ts` | 删号时取消外部订阅 | L96-107 Paddle 分支，L108-115 Stripe 分支。GDPR 合规必备 |
| `supabase/functions/_shared/cors.ts` | CORS 头工具 | 直接复用 |

### 3.4 前端集成（PWA 层）

| 文件 | 作用 | 关键行 |
|---|---|---|
| `hosted-pwa/public/config.js` | **前端公共配置**（可入仓库） | `paddleClientToken` 必须 `live_` 前缀；`paddleEnvironment` 必须 `production` |
| `hosted-pwa/public/billing.js` | Edge Function 调用封装（60 行，非常薄） | 所有支付细节由后端决定，前端只发请求拿 URL 跳转 |
| `src/public/app.js` | 主应用逻辑 | L524-550 `openBillingSession`：后端返回 `transactionId` → `Paddle.Checkout.open()` overlay；否则 `location.href = url`（Stripe 路径）。L573-596 `initializePaddleForCurrentUser`：强制校验 environment=production 且 token 以 `live_` 开头。L620-627 检测 URL 参数 `_ptxn=txn_...` 自动打开 overlay。L632-685 `handleBillingCallback` 支付成功后轮询 `subscriptions` 表（最多 10 次 × 3 秒） |
| `hosted-pwa/tests/static-build.test.mjs` | 构建时校验前端配置 | L17-34 正则固化 `live_` 前缀、禁止 sandbox、要求 `Paddle.Initialize` |

### 3.5 部署和运维

| 文件 | 作用 | 关键行 |
|---|---|---|
| `scripts/deploy.sh` | 部署脚本 | L43-51 列出 5 个支付 Edge Function 及 JWT 验证策略；**L117-121 生产部署安全门**：`paddleClientToken` 必须 `live_` 开头且 `PADDLE_LIVE_DEPLOY_APPROVED=1` |
| `supabase/config.toml` | Edge Function JWT 配置 | L7-20：`billing-create-*` / `billing-get-client-context` 开 JWT；`paddle-webhook` / `stripe-webhook` 关 JWT（外部回调用签名验签） |
| `.env.example` | 环境变量模板 | L18-36 列出全部变量名（值留空）。**注意 L19 默认值 `stripe` 与代码运行时默认 `paddle` 不一致，新项目应统一为 `paddle`** |

---

## 四、实施步骤建议

按以下顺序实施，每步完成后独立验证：

### Step 1：Paddle 账户准备（人工）
完成 `docs/superpowers/specs/2026-08-02-stripe-to-paddle-migration-design.md` 第 4 节的 7 项前置条件（账户验证、网站审核、Product/Price 创建、Hosted Checkout 审批）。**不要等开发完成后才确认这些**。

### Step 2：数据库迁移
参考 `0016_migrate_stripe_to_paddle.sql` 创建 4 张表 + 3 个 RPC，但：
- 直接用 `20260804042520_fix_billing_event_effect_contract.sql` 里的 `process_billing_event` 版本
- 如果新项目没有历史 Stripe 数据，跳过 L132-170 的回填段
- 加上 `20260805050100` 的 FK 索引

### Step 3：Edge Function 实现
按 3.3 清单依次实现，建议顺序：
1. `_shared/cors.ts`（无依赖）
2. `_shared/paddle.ts`（依赖 cors）
3. `paddle-webhook/index.ts`（依赖 paddle.ts）
4. `billing-create-checkout-session/index.ts`
5. `billing-create-portal-session/index.ts`
6. `billing-get-client-context/index.ts`
7. `account-delete/index.ts`（GDPR 必备）

### Step 4：配置 Secrets
**绝不写入 `.env`**。用以下命令注入（替换 `<new-project-ref>` 为新项目的 Supabase project ref）：

```bash
supabase secrets set \
  BILLING_PROVIDER=paddle \
  PADDLE_API_KEY=<新项目的 Paddle API Key> \
  PADDLE_ENVIRONMENT=production \
  PADDLE_WEBHOOK_SECRET=<新项目的 Webhook 验签密钥> \
  PADDLE_PRICE_ID=<新项目创建的 Price ID> \
  PADDLE_HOSTED_CHECKOUT_URL=<新项目的 Hosted Checkout URL> \
  PADDLE_SUCCESS_URL=<新项目的前端成功回跳 URL> \
  --project-ref <new-project-ref>
```

### Step 5：前端集成
参考 `hosted-pwa/public/config.js` 配置新项目的 `paddleClientToken` 和 `supabaseUrl`/`supabaseAnonKey`。

### Step 6：构建时校验
复制 `hosted-pwa/tests/static-build.test.mjs` 的正则规则到新项目，确保前端配置符合 production 要求。

### Step 7：端到端测试
用 Paddle sandbox 模拟订阅生命周期事件（创建、激活、续费、取消、退款），验证 `subscriptions` 表状态正确投影。

---

## 五、容易踩坑的点（前人教训）

以下是 VoiceBridge 迭代过程中踩过的坑，新项目要避免重蹈：

1. **`process_billing_event` 的 effect.type 比较错误**：0016 原版把 `effect.type`（值是 `subscription/transaction/ignore`）和 Paddle 事件名（`subscription.created`）比较，导致有效事件被静默丢弃。修复见 `20260804042520`。**这是最严重的 bug**。
2. **`claim_checkout_attempt` 的歧义错误**：0016 原版的 SELECT 在某些场景下抛出"column reference is ambiguous"，经过 0018/0019/0020 三次修复才稳定。新项目直接用修复后的版本。
3. **Webhook 验签顺序**：必须先 `req.text()` 读原始 body，**再**调 `paddle.webhooks.unmarshal()`。如果先 `req.json()` 解析再用 `JSON.stringify()` 重组，签名验证会失败（字段顺序不同）。
4. **`STRIPE_PORTAL_RETURN_URL` 是隐藏配置**：`billing-create-portal-session/index.ts:135` 读取但 `.env.example` 没列出。新项目要么显式列出，要么删掉这个 fallback。
5. **`BILLING_PROVIDER` 默认值不一致**：`.env.example` 默认 `stripe`，`paddle.ts:118` 运行时默认 `paddle`。新项目应统一。
6. **前端轮询 ≠ Webhook 落库**：支付成功后前端跳转 `?billing=success`，但 Webhook 可能有延迟。`app.js` L632-685 的轮询逻辑是这个问题的缓解方案，不要省略。
7. **IP allowlist fail-open**：早期实现 IP 拉取失败时返回 `true`（放行），这会被攻击者利用。必须 fail-closed 返回 503。
8. **Paddle SDK 版本锁定**：必须用 `@3.8.0`，其他版本的类型定义和 API 行为不完全一致。

---

## 六、和 VoiceBridge 的差异点

新项目实施时**必须**与 VoiceBridge 做以下区分：

| 维度 | VoiceBridge | 新项目应该 |
|---|---|---|
| Supabase project ref | `gqxxknusznbunkiznnal` | 新建独立 project |
| Paddle 账户 | VoiceBridge 的 Paddle 账户 | 单独申请账户，避免财务混账 |
| PADDLE_API_KEY | VoiceBridge 的服务端 key | 新账户的 key |
| PADDLE_PRICE_ID | VoiceBridge Pro 月订阅 `pri_...` | 新项目创建独立 Product + Price |
| PADDLE_CLIENT_TOKEN | `live_41b31a9d8a0a8f7ca79db094438` | 新账户的 client token |
| SUPABASE_ANON_KEY | VoiceBridge 的 anon key | 新 project 的 anon key |
| Webhook endpoint URL | `voicebridge.app/functions/v1/paddle-webhook` | 新项目域名下的 webhook URL |
| PADDLE_HOSTED_CHECKOUT_URL | VoiceBridge 审批过的 checkout URL | 新项目需独立审批 |

---

## 七、验证清单

实施完成后逐项验证：

- [ ] 数据库：4 张表已创建，3 个 RPC 权限正确（`service_role` 可执行，`anon/authenticated` 不可执行）
- [ ] RLS：所有支付相关表启用 RLS（即使只有 service_role 写入）
- [ ] Edge Function：5 个函数已部署，JWT 策略正确（billing-* 开 JWT，webhook 关 JWT）
- [ ] Secrets：所有 `PADDLE_*` 已通过 `supabase secrets set` 注入，**不在 `.env` / git / 前端**
- [ ] Webhook 安全：IP allowlist 工作（伪造 IP 返回 403），签名错误返回 401
- [ ] 幂等性：同一事件 ID 重复投递，第二次返回 `duplicate`，不产生副作用
- [ ] 乱序控制：旧事件后到，返回 `stale`，不覆盖新状态
- [ ] 并发控制：同用户同时发两个 checkout 请求，只产生一个 Paddle Transaction
- [ ] 前端：`paddleClientToken` 以 `live_` 开头，构建测试通过
- [ ] 端到端：sandbox 完成订阅 → Webhook 落库 → `subscriptions.status = active` → 前端轮询检测到

---

## 八、如何使用本文档

把这份文档作为**系统提示**或**首条消息**发给 AI 助手，然后告诉它：

> "我要在新项目 `<new-project-path>` 实现这套 Paddle 支付架构。请先逐个阅读上面列出的所有参考文件（路径在 `/Users/hl/Projects/VoiceBridge/` 下），理解每个设计决策的动机，然后按 Step 1-7 的顺序指导我实施。实施前先用 TodoWrite 列出任务清单。"

AI 助手会先通读参考文件，然后按本文档的规范在新项目里复刻一套架构等价但凭证隔离的系统。
