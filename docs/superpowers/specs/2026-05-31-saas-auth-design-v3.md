# VoiceBridge SaaS v3: Slim Productization Plan

**Date**: 2026-05-31
**Status**: Draft - Review Required
**Supersedes**: `2026-05-31-saas-auth-design-v2.md`
**Revision reason**: 收敛 v2 范围，优先实现同账号跨网络连接、桌面客户端、云端 ASR、订阅与额度控制，并为后续本地/自托管 ASR 留出扩展点。

---

## 1. 一句话方案

把 VoiceBridge 从“电脑开本地服务 + 手机扫局域网二维码”升级为：

> 手机打开公网 PWA 或后续 App，桌面安装轻量 Agent。两端登录同一个账号后，手机录音并在云端转写，转写文本通过 Supabase Realtime 发给目标桌面端，桌面端复用现有剪贴板和自动粘贴能力。

MVP 不重写核心功能，不做复杂设备配对，不做 P2P/Tunnel，不做命令云同步，不做历史记录。先把“下载桌面客户端、登录同账号、跨网络输入文字”跑通。

---

## 2. 目标与非目标

### 2.1 本次目标

1. 用户可以注册、登录、退出。
2. 用户在手机端和桌面端登录同一账号后，无需扫码即可连接。
3. 手机和电脑不在同一个局域网时也能通信。
4. 桌面端以可下载客户端形式分发，用户不需要安装终端或 Node.js。
5. ASR 密钥只保存在云端，前端和桌面客户端都不暴露密钥。
6. 加入订阅与额度控制，避免平台 ASR 成本失控。
7. 保留现有本地局域网模式，作为开发、离线或高级用户兜底。
8. 为后续本地/自托管 ASR 预留清晰扩展点。

### 2.2 明确不做

1. MVP 不做手机原生 App，上线前先用 Hosted PWA。
2. MVP 不做命令库云同步，继续保留本地命令文件或本地状态。
3. MVP 不保存录音音频，不默认保存转写文本。
4. MVP 不做长音频、历史记录、团队空间、管理员后台。
5. MVP 不做 WebRTC、内网穿透、端到端音频 P2P。
6. MVP 不做桌面自动更新，先提供手动下载安装包。

---

## 3. 决策总表

| 决策 | v3 选择 | 原因 |
|------|---------|------|
| 部署模式 | SaaS 公共服务 + 保留本地模式 | 满足跨网络使用，同时不破坏现有 MVP |
| Auth | Supabase Auth | 快速获得注册、登录、JWT、会话管理 |
| DB | Supabase Postgres + RLS | 用户数据隔离简单直接 |
| 实时通信 | Supabase Realtime private channel | 桌面端无需公网 IP，无需端口映射 |
| ASR MVP | 云端 Tencent ASR via Edge Function | 最快上线，密钥集中管理 |
| ASR 未来 | Provider abstraction: `tencent_cloud` -> `self_hosted_whisper` / `desktop_local` | 后续降低成本，不重写业务流程 |
| 订阅 | Stripe Billing + Checkout + Customer Portal | 不自建支付表单，不手写续费逻辑 |
| 桌面客户端 | Electron Agent | 最容易复用现有 Node 剪贴板/粘贴逻辑 |
| 手机端 | Hosted PWA first | 用户无需安装，最快验证 |
| 音频格式 | 客户端优先编码 16k mono WAV | 避开 webm/m4a 容器兼容风险，贴近当前本地 ffmpeg 输出 |

---

## 4. 系统架构

```text
Phone PWA                         Supabase Cloud / Edge                Desktop Agent
   |                                      |                                  |
   |-- sign up / sign in ---------------->| Auth                             |
   |                                      |                                  |
   |-- presence subscribe ----------------| Realtime private                 |
   |<-- online desktop devices -----------| user:{uid}:presence              |
   |                                      |                                  |
   |-- record 16k wav --------------------|                                  |
   |-- POST /transcribe ----------------->| Edge Function                    |
   |   JWT + quota + plan check           | Tencent ASR / future provider    |
   |<-- text -----------------------------| usage_events recorded            |
   |                                      |                                  |
   |-- broadcast insert_text ------------>| device:{uid}:{desktopDeviceId} --|
   |                                      |                                  |-- write clipboard
   |                                      |                                  |-- optional auto paste
   |<-- ack ------------------------------| device:{uid}:{phoneDeviceId} <---|
   |                                      |                                  |
   |-- create checkout / portal session ->| Stripe Edge Functions            |
   |<-- redirect URL ---------------------|                                  |
   |                                      |<-- Stripe webhook ---------------|
   |                                      | update subscription state         |
```

### 4.1 现有代码如何保留

当前代码中最有价值的能力是：

- `src/server/input/outputText.js`: 复制、自动粘贴、目标窗口输出。
- `src/server/input/paste.js`: macOS / Windows / Linux 键盘模拟。
- `src/server/asr/*`: 本地模式下的 ffmpeg 转 WAV + Tencent ASR。
- `src/public/app.js`: 手机端录音、状态展示、快捷指令 UI。

v3 不把这些推倒重写。做法是新增一条 cloud mode：

| 模式 | 手机端连接 | ASR 位置 | 文本输出位置 | 用途 |
|------|------------|----------|--------------|------|
| Local mode | 手机访问桌面局域网地址 | 桌面本地 Node 服务 | 桌面本机 | 保留现有 MVP |
| Cloud mode | 手机访问公网 PWA | Edge Function 云端 ASR | Electron Agent | 面向普通用户 |

后续代码结构上，把“录音上传”和“输出命令发送”抽成小接口即可，不需要一次性重构整个 `app.js`。

---

## 5. 核心数据模型

只保留 MVP 真正需要的表。

### 5.1 `profiles`

保存用户产品侧资料和 Stripe 关联关系。用户只能读取自己的 profile，不能自行修改订阅状态。

```sql
create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 5.2 `devices`

保存同账号设备。撤销设备时只改 `status`，不物理删除，便于审计和避免旧客户端误连。

```sql
create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  device_type text not null check (device_type in ('phone', 'desktop')),
  platform text not null,
  app_version text,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 5.3 `subscriptions`

Stripe webhook 是订阅状态唯一可信来源。客户端不能直接写这张表。

```sql
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text unique,
  stripe_price_id text,
  plan text not null default 'free',
  status text not null default 'free',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

有效付费状态只认：

- `trialing`
- `active`

其他状态，如 `past_due`, `unpaid`, `canceled`, `incomplete`, `incomplete_expired`，按免费额度或暂停云端 ASR 处理。

### 5.4 `usage_events`

记录用量和成本估算。由 `/transcribe` 写入，用户最多只能读取自己的用量摘要。

```sql
create table usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  provider text not null,
  mode text not null default 'cloud',
  audio_duration_ms int,
  audio_size_bytes int,
  status text not null check (status in ('success', 'failed', 'rejected')),
  error_code text,
  cost_estimated numeric(10, 6),
  created_at timestamptz not null default now()
);
```

### 5.5 `stripe_events`

用于 webhook 幂等，避免 Stripe 重试导致重复更新。

```sql
create table stripe_events (
  id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);
```

### 5.6 额度配置

MVP 不做用户可编辑的 `usage_limits` 表，避免用户通过 RLS 或 API 绕过限制。额度先写在 Edge Function 的 server-side 配置里：

```js
const PLAN_LIMITS = {
  free: { monthlySeconds: 600, maxAudioSeconds: 60, rateLimitPerMinute: 10 },
  pro: { monthlySeconds: 18000, maxAudioSeconds: 60, rateLimitPerMinute: 30 }
};
```

后续需要运营后台时，再把 plan limits 放进只允许 service role 写入的表。

### 5.7 RLS 与 Data API

所有 public schema 表都启用 RLS。新建表是否自动暴露给 Supabase Data API 取决于项目设置；如果前端需要直接读取 `devices` 或订阅状态，需要显式授予 `authenticated` 对应表的最小权限，再依赖 RLS 控制行级访问。

权限边界：

| 表 | 客户端权限 | 服务端权限 |
|----|------------|------------|
| `profiles` | 读自己的记录 | 创建 profile、写 `stripe_customer_id` |
| `devices` | 管理自己的 active/revoked 设备 | 可做清理和审计 |
| `subscriptions` | 只读自己的订阅状态 | Stripe webhook 写入 |
| `usage_events` | 只读自己的用量记录或摘要 | `/transcribe` 写入 |
| `stripe_events` | 无 | Stripe webhook 写入 |

不要把订阅状态、额度、角色放进用户可编辑的 `user_metadata`。需要放进 JWT 的授权字段必须来自 server-controlled `app_metadata`，但 v3 MVP 优先直接查 DB，避免 JWT 刷新延迟带来的状态不一致。

---

## 6. Realtime 通信协议

全部使用 private channel，并在 `realtime.messages` 上加 RLS。Supabase Realtime 的授权在客户端 join channel 时计算，不能只依赖难猜的频道名。

### 6.1 Channel

| Channel | 用途 |
|---------|------|
| `user:{userId}:presence` | 同账号设备在线状态 |
| `device:{userId}:{deviceId}` | 点对点命令和 ack |

### 6.2 消息

手机发给桌面：

```json
{
  "type": "insert_text",
  "request_id": "uuid-v4",
  "source_device_id": "phone-device-id",
  "target_device_id": "desktop-device-id",
  "text": "识别后的文字",
  "auto_paste": true,
  "created_at": "2026-05-31T12:00:00Z"
}
```

桌面回给手机：

```json
{
  "type": "ack",
  "request_id": "uuid-v4",
  "source_device_id": "desktop-device-id",
  "target_device_id": "phone-device-id",
  "status": "success",
  "detail": "pasted"
}
```

桌面端必须校验：

1. `target_device_id === myDeviceId`
2. 本地设备状态不是 `revoked`
3. 消息类型在白名单内
4. `text` 长度不超过上限，例如 10,000 字符

---

## 7. ASR 设计

### 7.1 MVP: 云端 Tencent ASR

手机端录音后优先生成 16kHz mono WAV，再以 multipart/form-data 上传到 `/transcribe` Edge Function。Edge Function 负责：

1. 校验 Supabase JWT。
2. 查询用户订阅状态。
3. 查询当月成功用量和最近一分钟请求数。
4. 校验音频大小、时长、MIME。
5. 调用 Tencent ASR。
6. 写入 `usage_events`。
7. 返回转写文本。

选择客户端 WAV 的原因：

- 当前本地模式也是转成 16k WAV 后调用腾讯 ASR，识别路径更接近现有已验证行为。
- 避免 Android Chrome 默认 `webm` 不被腾讯 ASR 接受的问题。
- 避免在 Edge Function 中打包 ffmpeg；Supabase hosted Edge Function 有 20MB 打包限制和 2s CPU 限制，不适合重转码。
- 60 秒 16k mono PCM WAV 大约 1.9MB，仍在短语音可接受范围内。

### 7.2 Phase 0 必做 spike

正式开发云端 ASR 前，先验证：

1. Android Chrome / iOS Safari 是否能稳定采集 PCM 并编码 16k WAV。
2. 55-60 秒 WAV 文件大小是否稳定小于 Tencent 及 Edge Function 限制。
3. Tencent ASR 对客户端 WAV 的准确率是否接近当前本地 ffmpeg WAV。
4. Supabase Edge Function 接收 multipart 音频、转 base64、调用 Tencent 的耗时是否稳定。

如果客户端 WAV 在某些手机上不稳定，备选顺序：

1. iOS 走 `audio/mp4` -> Tencent `m4a`，Android 走客户端 WAV。
2. Android 引入 `opus-media-recorder` 生成 `ogg-opus`。
3. 独立部署一个轻量 Node/容器转码服务，不放在 Edge Function。

### 7.3 未来: 本地或自托管 ASR

v3 要把 ASR 作为 provider，不把业务逻辑绑死在 Tencent。

```ts
type AsrProvider = 'tencent_cloud' | 'self_hosted_whisper' | 'desktop_local';
```

推荐演进顺序：

1. `tencent_cloud`: MVP，最快上线。
2. `self_hosted_whisper`: 平台自建 faster-whisper / whisper.cpp 服务，Edge Function 只做代理和鉴权，降低长期成本。
3. `desktop_local`: 高级模式，桌面 Agent 下载手机上传的短音频并本地转写，云端只做账号、设备、消息和临时音频中转。

`desktop_local` 不进 MVP，因为它会引入临时音频存储、桌面下载任务、失败重试、隐私提示和跨设备进度同步。先把 provider 接口留好即可。

---

## 8. 订阅与额度

### 8.1 产品形态

MVP 两档即可：

| Plan | 用途 | 建议限制 |
|------|------|----------|
| Free | 试用和自然传播 | 每月少量分钟数，例如 10 分钟 |
| Pro Monthly | 主力付费 | 每月较高分钟数，例如 300 分钟 |

不要一开始做复杂套餐、按量计费、团队席位或优惠券系统。等真实用量和成本出来后再调整。

### 8.2 Stripe 集成

使用 Stripe Billing + Checkout：

1. 用户点击升级。
2. 前端调用 Edge Function `/billing/create-checkout-session`。
3. Edge Function 使用 service role 查询/创建 `stripe_customer_id`。
4. Edge Function 创建 Stripe Checkout Session，`mode: 'subscription'`。
5. 用户在 Stripe Checkout 完成支付。
6. Stripe webhook 更新 `subscriptions`。
7. 前端刷新订阅状态。

自助管理使用 Stripe Customer Portal：

1. 用户点击管理订阅。
2. 前端调用 `/billing/create-portal-session`。
3. 跳转 Stripe Portal，用户自行改卡、取消、恢复订阅。

### 8.3 Webhook 事件

MVP 至少处理：

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

访问权限以 webhook 同步后的 `subscriptions.status` 为准，不以 Checkout return URL 为准。

### 8.4 用量拦截

`/transcribe` 每次执行前检查：

1. 订阅是否为 `active` 或 `trialing`。
2. 当前 plan 对应月额度是否足够。
3. 单次录音是否超过 `maxAudioSeconds`。
4. 最近一分钟请求数是否超过 `rateLimitPerMinute`。

超限返回明确错误：

```json
{
  "ok": false,
  "code": "quota_exceeded",
  "message": "本月语音额度已用完，请升级或下月再试。"
}
```

失败和拒绝请求也写入 `usage_events`，便于排查滥用。

---

## 9. 桌面客户端

### 9.1 MVP Agent

Electron Agent 只做五件事：

1. 登录/退出 Supabase 账号。
2. 注册或恢复本机 `device_id`。
3. 上报 Presence。
4. 订阅 `device:{uid}:{deviceId}`。
5. 收到 `insert_text` 后调用现有 `outputText()`，再回 ack。

MVP UI 保持克制：

- 登录窗口。
- 当前账号。
- 设备名称。
- 连接状态。
- 辅助功能权限提示。
- 退出登录。

不做复杂设置页，不做命令编辑器，不做内置手机页面。

### 9.2 打包

优先使用 Electron Forge。原因是 Electron 官方维护，和签名、公证流程更贴近。

阶段策略：

1. 开发期：Node CLI Agent，最快验证 Realtime + 粘贴。
2. 内测期：未签名 Electron 包，给可信测试用户。
3. 公开下载：macOS 做 Developer ID 签名和 notarization；Windows 后续考虑代码签名。

macOS 自动粘贴仍需要辅助功能权限，这是系统限制，客户端只能做清晰引导，不能绕过。

---

## 10. 手机端

MVP 使用 Hosted PWA：

1. 用户打开固定网址。
2. 登录账号。
3. 自动发现在线桌面设备。
4. 选择目标桌面。
5. 录音、转写、发送到桌面。

后续再用 Capacitor 封装 App。Capacitor 只作为分发和原生能力增强层，不改变核心云端协议。

---

## 11. 安全与隐私

| 风险 | 设计 |
|------|------|
| 用户越权读写数据 | 所有用户表启用 RLS |
| 用户伪造订阅 | `subscriptions` 只由 Stripe webhook/service role 写 |
| 用户伪造用量 | `usage_events` 只由 `/transcribe` service role 写 |
| Realtime 频道被猜到 | private channel + `realtime.messages` RLS |
| 多桌面误粘贴 | per-device channel + `target_device_id` 校验 |
| ASR 密钥泄露 | 只放 Edge Function secrets |
| 音频隐私 | 默认不保存音频；请求结束即丢弃 |
| 文本隐私 | 默认不保存转写文本 |
| Stripe webhook 重放 | 校验 Stripe signature + `stripe_events` 幂等 |
| 被刷 ASR 成本 | 订阅状态、月额度、单次时长、速率限制 |

RLS 原则：

- `devices`: 用户可管理自己的设备，但不能管理别人设备。
- `profiles`: 用户可读自己的 profile；订阅相关字段只能 server 写。
- `subscriptions`: 用户只读自己的订阅状态。
- `usage_events`: 用户只读自己的用量摘要；插入/更新/删除只允许 server。
- `stripe_events`: 不暴露给客户端。

---

## 12. 推荐实施阶段

### Phase 0: 技术 spike

目标：证明最关键风险可控。

1. Supabase Auth 登录链路。
2. Realtime private channel + RLS。
3. 手机输入一段文字，跨网络发送到桌面 Agent，并自动粘贴。
4. 客户端 16k WAV 录音在 Android/iOS 上可用。
5. Edge Function 调 Tencent ASR 可用。

通过标准：不在同一局域网的手机和电脑，登录同账号后能完成一次“录音 -> 识别 -> 粘贴”。

### Phase 1: Cloud Mode MVP

1. Hosted PWA 登录。
2. Desktop CLI Agent 登录。
3. 设备注册、Presence、设备选择。
4. `insert_text` / `ack` 协议。
5. 复用现有剪贴板和自动粘贴。

### Phase 2: 云端 ASR + 额度

1. 客户端 WAV 录音。
2. `/transcribe` Edge Function。
3. `usage_events`。
4. 免费额度和速率限制。
5. 错误提示和前端状态。

### Phase 3: 订阅

1. Stripe Checkout Session。
2. Stripe webhook。
3. `subscriptions` 同步。
4. Customer Portal。
5. Pro 额度生效。

### Phase 4: Electron 客户端

1. Electron 登录窗口。
2. 托盘/菜单栏常驻。
3. 权限提示。
4. macOS 安装包。
5. Windows 安装包。

### Phase 5: 成本优化

1. 抽象 ASR provider。
2. 接入自托管 Whisper 服务。
3. 根据真实成本调整订阅额度。
4. 评估 `desktop_local` 是否值得做。

---

## 13. v3 相对 v2 的主要变化

| 项目 | v2 | v3 |
|------|----|----|
| 范围 | 完整 SaaS 蓝图 | 最小可上线产品路径 |
| 手机端 | PWA -> Capacitor 写入主路线 | Hosted PWA first，App 后置 |
| 音频格式 | ogg-opus/m4a 直传为主 | 16k WAV 客户端编码优先 |
| Storage | 长音频兜底 | MVP 不做 |
| commands 云同步 | 纳入架构 | MVP 不做 |
| usage_limits | 用户表形式 | server-side plan limits |
| 订阅 | 未覆盖 | Stripe Billing + Checkout + Portal |
| ASR 未来 | 主要围绕 Tencent 兼容 | 明确 provider abstraction 和 self-hosted/local 路线 |
| 桌面端 | Electron 正式客户端较早进入 | 先 CLI Agent 验证，再 Electron 包装 |
| 成本控制 | 额度表 + 频率限制 | 订阅状态 + plan limits + usage_events |

---

## 14. 最小成功标准

v3 的第一个可发布版本只需要满足：

1. 用户能下载桌面客户端并登录。
2. 用户能在手机网页登录同账号。
3. 手机能看到在线桌面设备。
4. 手机录音后，目标桌面能收到文字并粘贴。
5. 非同一局域网也能成功。
6. 免费用户有明确额度。
7. 付费用户能通过 Stripe 订阅获得更高额度。
8. 用户音频和转写文本默认不保存。

做到这些，就已经从 MVP 进入“可面向用户试用的产品”。
