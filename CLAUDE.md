# VoiceBridge

语音输入工具：把手机变成 macOS/Windows 的语音输入遥控器。

## 技术栈

- **前端 PWA**：静态 JS（无框架），Cloudflare Pages 部署
- **后端**：Supabase（Postgres + Auth + Edge Functions / Deno）
- **支付**：Paddle（Merchant of Record）+ Stripe（遗留迁移通道）
- **语音识别**：腾讯云 ASR
- **桌面端**：Electron（计划中）

## 项目结构

```
hosted-pwa/          # Cloud Pages 前端（生产镜像）
  public/            # PWA 静态资源（app.js / billing.js / style.css / i18n/）
  landing/           # 落地页模板 + i18n locale JSON
  scripts/           # 构建脚本（build-landing.mjs / deploy.sh）
src/public/          # 前端源码（与 hosted-pwa/public 保持同步）
supabase/
  functions/         # Deno Edge Functions
  migrations/        # SQL 迁移文件
  _shared/           # Edge Function 共享代码
docs/                # 设计文档
scripts/             # 部署 / 运维脚本
```

## Paddle 集成规范

- **SDK**：`npm:@paddle/paddle-node-sdk@3.8.0`（Edge Function 中通过 `npm:` 导入）
- **环境**：开发用 sandbox（API key 含 `_sdbx`，client token 前缀 `test_`），生产用 production
- **Webhook 验签**：必须读取原始 body，在 JSON 解析前调用 `paddle.webhooks.unmarshal(rawBody, secret, signature)`
- **密钥管理**：所有 Paddle 凭证通过 `supabase secrets set` 配置，绝不内联到代码中
- **支付商切换**：通过 `BILLING_PROVIDER` 环境变量控制（`paddle` 或 `stripe`），默认 `paddle`
- **Price 校验**：Webhook 中必须通过 `validatePaddlePrice` 校验 `priceId` 是否匹配 `PADDLE_PRICE_ID`

## 前端源码同步

`src/public/` 和 `hosted-pwa/public/` 必须保持一致。`hosted-pwa/scripts/build-landing.mjs`
中的 `verifyMirroredSources` 会在构建时检查，不一致则报错。

## 数据库迁移

迁移文件在 `supabase/migrations/`，按编号递增。Edge Functions 通过 RPC 调用数据库逻辑，
不直接操作表（确保 RLS 和幂等性）。

## Supabase Secrets

Edge Function 环境变量通过 Supabase CLI 设置：

```bash
supabase secrets set PADDLE_API_KEY=... --project-ref <ref>
```

不写入 `.env`（`.env` 仅用于本地 Node 服务）。
