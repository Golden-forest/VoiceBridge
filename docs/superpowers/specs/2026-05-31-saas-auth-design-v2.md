# VoiceBridge SaaS v2: 用户认证与跨网络语音输入

**Date**: 2026-05-31
**Status**: Draft — Review Required
**Supersedes**: `2026-05-31-saas-auth-design.md` (v1, Approved)
**Revision reason**: 修正 v1 中腾讯 ASR 格式兼容性事实错误、Realtime 安全缺失、多设备路由缺陷、音频链路矛盾、成本控制缺失等问题。

---

## 1. 决策总表

| 决策 | 选择 | 说明 |
|------|------|------|
| 部署模式 | SaaS 公共服务 | 任何人可注册使用 |
| 后端架构 | Supabase (Auth, DB, Realtime, Edge Functions) | + 可选 Storage 做长音频兜底 |
| ASR 计费 | 平台统一承担（腾讯云密钥） | 必须有额度限制 |
| 桌面客户端 | Electron（首选）/ Tauri（备选） | 需代码签名 + 公证 |
| 手机客户端 | Web PWA（过渡方案）→ Capacitor 封装 App | PWA 不是最终形态 |
| 注册方式 | Email + password (Supabase Auth) | — |

---

## 2. 系统架构

### 2.1 组件

```
手机端 (PWA → App)           Supabase Cloud              桌面端 (Electron Agent)
    |                              |                              |
    |-- register/login ---------->| Auth                          |
    |                              |                              |
    |-- POST audio ------------->| Edge Function /transcribe    |
    |   (已适配格式)              |   JWT 校验                    |
    |                              |   额度校验                    |
    |                              |   MIME/大小/时长校验          |
    |                              |   腾讯 ASR 调用               |
    |<-- 转写文本 ----------------|   usage_event 记录            |
    |                              |                              |
    |-- Broadcast --------------->| Realtime (private channel)   |
    |   { target_device_id }      |   device:{uid}:{deviceId}    |
    |                              |------------------------------->|
    |                              |   校验 target_device_id      |
    |                              |   写剪贴板 / 模拟粘贴        |
    |                              |   返回 ack                   |
    |<-- ack --------------------|<------------------------------|
    |                              |                              |
    |-- Presence sync ----------->| user:{uid}:presence           |
    |                              |   发现在线设备               |
    |                              |                              |
    |-- commands CRUD ----------->| DB (commands, RLS)           |
```

### 2.2 核心设计原则

1. 不重构已跑通的局域网核心逻辑，SaaS 链路作为新通道并行接入
2. 不默认保存用户音频和转写文本
3. 音频不走 Realtime
4. 多桌面端不会同时收到同一条输入命令
5. 腾讯云密钥不暴露给前端或桌面端
6. PWA 是过渡方案，文档中明确标注
7. 所有用户数据通过 RLS 隔离
8. 所有 ASR 请求有额度和频率限制
9. 所有关键消息有 `request_id` 和 `ack`
10. 每个阶段保持项目可运行、可验证

---

## 3. 音频格式策略（关键修正）

### 3.1 问题背景

v1 设计声称浏览器原生录音格式（webm, m4a）可被腾讯 ASR 直接接收。**经验证，这是事实错误：**

- 腾讯 ASR `SentenceRecognition` 支持的格式：`wav, pcm, ogg-opus, speex, silk, mp3, m4a, aac, amr`
- **不支持 webm**（Android Chrome 默认输出）
- 支持 `ogg-opus`（Opus 编码在 OGG 容器中），但 Android 默认输出 `webm`（Opus 编码在 WebM 容器中）
- 容器格式不同导致不兼容，即使编码相同

### 3.2 客户端格式适配

Edge Function 运行在 Deno 沙箱中，无子进程权限，ffmpeg 不可用。ffmpeg.wasm 完整版 25-32MB 超出 Edge Function 20MB 打包上限，且 2s CPU 限制不满足音频转码。

**方案：在客户端侧完成格式适配，Edge Function 只做代理转发。**

| 平台 | 浏览器默认输出 | 腾讯 ASR 需要 | 客户端适配方案 |
|------|--------------|-------------|--------------|
| Android Chrome | `audio/webm` (Opus in WebM) | `ogg-opus` (Opus in OGG) | 使用 `opus-media-recorder` 库替代原生 MediaRecorder，直接录 OGG |
| iOS Safari | `audio/mp4` (AAC, 48kHz) | `m4a` | mp4 容器 rename 为 m4a 可行；但 Safari 固定 48kHz 采样率，可能影响识别质量 |
| Desktop Chrome/Firefox | `audio/webm` (Opus) | `ogg-opus` | 同 Android，使用 `opus-media-recorder` |
| Desktop Safari | `audio/mp4` (AAC) | `m4a` | 同 iOS |

### 3.3 Phase 0 必须验证的风险

在进入正式开发前，必须做技术 spike 验证以下假设：

1. `opus-media-recorder` 在 Android Chrome / iOS Safari 上的可用性和录音质量
2. iOS Safari 录制的 `audio/mp4`（48kHz AAC）直接用 `VoiceFormat=m4a` 发给腾讯 ASR 的识别准确率（vs 16kHz WAV 基线）
3. Android Chrome 用 `opus-media-recorder` 录制的 `audio/ogg` 发给腾讯 ASR 的识别准确率
4. Edge Function 请求体大小实际限制（文档未明确，Deno Deploy 约 6MB）

**如果 ogg-opus 或 m4a 直传质量不达标，备选方案：**
- 浏览器端用 Web Audio API 做 PCM 16kHz 重采样并编码为 WAV（纯 JS，无 ffmpeg）
- 或单独部署一个轻量 Node/容器服务做转码（不放在 Edge Function 中）

### 3.4 音频传输路径

**短音频（< 5MB，约 60s 录音）：** 客户端直接 POST base64 到 Edge Function `/transcribe`

**长音频或 Edge Function 限制命中时：**
1. 客户端上传到 Supabase Storage（`audio-uploads` bucket）
2. 客户端调用 Edge Function `/transcribe` 并传入 Storage path
3. Edge Function 从 Storage 下载音频，调腾讯 ASR，返回文本
4. Storage 文件 24h 后自动过期清理

Storage 不是默认路径，仅做兜底。默认路径是直接 POST。

---

## 4. Realtime 通信协议（关键修正）

### 4.1 问题背景

v1 使用 `device-{userId}` 单一频道。问题：
- 同一用户多台桌面端会同时收到消息，导致多台电脑同时粘贴
- 没有使用 private channel，没有 RLS 授权，频道名可被猜测

### 4.2 Channel 架构

使用三类 channel，全部设置 `private: true`，并通过 `realtime.messages` 表 RLS 策略控制访问：

| Channel | 命名格式 | 用途 | 订阅方 |
|---------|---------|------|--------|
| **设备消息通道** | `device:{userId}:{deviceId}` | 点对点发送文本/按键命令 | 手机端 + 目标桌面端 |
| **用户在线状态通道** | `user:{userId}:presence` | Presence 同步设备在线状态 | 用户所有设备 |

### 4.3 消息结构

**文本消息（手机 → 桌面）：**
```json
{
  "type": "insert_text",
  "request_id": "uuid-v4",
  "source_device_id": "phone-xxx",
  "target_device_id": "desktop-yyy",
  "text": "识别到的文字",
  "created_at": "2026-05-31T19:00:00Z"
}
```

**按键消息（手机 → 桌面）：**
```json
{
  "type": "key",
  "request_id": "uuid-v4",
  "source_device_id": "phone-xxx",
  "target_device_id": "desktop-yyy",
  "key": "enter",
  "created_at": "2026-05-31T19:00:00Z"
}
```

**Ack 消息（桌面 → 手机）：**
```json
{
  "type": "ack",
  "request_id": "uuid-v4",
  "target_device_id": "phone-xxx",
  "status": "success",
  "detail": "pasted"
}
```

桌面端**必须忽略** `target_device_id` 不等于自己 `deviceId` 的所有消息。

### 4.4 Realtime RLS 授权

在 `realtime.messages` 表上创建 RLS 策略，确保：
- 用户只能订阅自己的设备 channel
- 用户只能向自己的设备 channel 发送消息

```sql
-- 用户只能订阅/发送到自己的设备 channel
CREATE POLICY "user_own_device_channel_select"
  ON "realtime"."messages"
  FOR SELECT TO authenticated
  USING (
    (select realtime.topic()) LIKE 'device:' || (select auth.uid()) || ':%'
  );

CREATE POLICY "user_own_device_channel_insert"
  ON "realtime"."messages"
  FOR INSERT TO authenticated
  WITH CHECK (
    (select realtime.topic()) LIKE 'device:' || (select auth.uid()) || ':%'
  );

-- 用户只能参与自己的 presence channel
CREATE POLICY "user_own_presence_channel_select"
  ON "realtime"."messages"
  FOR SELECT TO authenticated
  USING (
    (select realtime.topic()) LIKE 'user:' || (select auth.uid()) || ':presence'
    AND "realtime"."messages"."extension" = 'presence'
  );

CREATE POLICY "user_own_presence_channel_insert"
  ON "realtime"."messages"
  FOR INSERT TO authenticated
  WITH CHECK (
    (select realtime.topic()) LIKE 'user:' || (select auth.uid()) || ':presence'
    AND "realtime"."messages"."extension" = 'presence'
  );
```

同时在 Supabase Dashboard → Realtime Settings 中禁用 "Allow public access"。

### 4.5 设备发现流程

1. 桌面端上线后，订阅 `user:{userId}:presence`，通过 Presence `track()` 上报 `{ deviceId, name, platform, status: "online" }`
2. 桌面端同时订阅自己的 `device:{userId}:{deviceId}` 消息通道
3. 手机端订阅 `user:{userId}:presence`，通过 Presence `sync` 事件获取在线设备列表
4. 手机端 UI 展示在线设备，用户选择目标设备后，手机端订阅目标设备的 `device:{userId}:{targetDeviceId}` 通道并发送消息

---

## 5. 语音输入主流程

1. 手机端已登录
2. 手机端通过 Presence 同步获取在线桌面设备列表
3. 用户选择目标桌面设备 `target_device_id`
4. 手机端录音（格式已通过客户端适配：Android 为 ogg-opus，iOS 为 m4a）
5. 手机端 POST 音频到 Edge Function `/transcribe`
6. Edge Function 校验 JWT、文件大小、MIME 类型、时长、用户剩余额度
7. Edge Function 调用腾讯 ASR
8. Edge Function 记录 `usage_event`（含失败）
9. 返回转写文本给手机端
10. 手机端通过 Realtime private channel 发送 `{ type: "insert_text", target_device_id, text, request_id }`
11. 桌面端收到消息，校验 `target_device_id === myDeviceId`
12. 桌面端写剪贴板，模拟粘贴
13. 桌面端返回 `{ type: "ack", request_id, status, detail }`
14. 手机端显示粘贴成功/失败

---

## 6. 数据库 Schema

### 6.1 devices 表

```sql
create table devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,                    -- "MacBook Pro", "Office PC"
  device_type   text not null default 'desktop',  -- 'mobile' | 'desktop'
  platform      text not null default 'macos',   -- 'ios' | 'android' | 'macos' | 'windows' | 'linux'
  app_version   text,
  status        text not null default 'active',  -- 'active' | 'revoked'
  last_seen_at  timestamptz,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table devices enable row level security;
create policy "users manage own devices"
  on devices for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

### 6.2 commands 表

```sql
create table commands (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  label         text not null,
  text          text not null,
  category      text not null default 'uncategorized',
  sort_order    int not null default 0,
  is_favorite   boolean not null default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table commands enable row level security;
create policy "users manage own commands"
  on commands for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

### 6.3 usage_events 表（新增）

```sql
create table usage_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  request_id      uuid,                             -- 关联客户端请求
  audio_duration_ms int,
  audio_size      int,
  voice_format    text,                              -- 'ogg-opus' | 'm4a' | 'wav'
  provider        text not null default 'tencent',   -- 预留多 ASR 提供商
  status          text not null,                     -- 'success' | 'failed' | 'rejected'
  error_code      text,                              -- ASR 返回的错误码
  cost_estimated  numeric(10,6),                     -- 估算成本
  created_at      timestamptz default now()
);

alter table usage_events enable row level security;
create policy "users manage own usage_events"
  on usage_events for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

### 6.4 usage_limits 表（新增）

```sql
create table usage_limits (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  daily_seconds_limit       int not null default 300,       -- 每日免费 5 分钟
  monthly_seconds_limit     int not null default 3000,      -- 每月免费 50 分钟
  max_audio_seconds        int not null default 60,         -- 单次最长 60s
  max_audio_size_bytes      int not null default 5242880,    -- 单次最大 5MB
  rate_limit_per_minute     int not null default 30,         -- 每分钟最多 30 次
  created_at                timestamptz default now(),
  updated_at                timestamptz default now(),

  unique(user_id)
);

alter table usage_limits enable row level security;
create policy "users manage own usage_limits"
  on usage_limits for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

### 6.5 transcriptions 表（调整）

默认不保存文本。`text` 允许为空。只有用户主动开启"历史记录"时才写入。

```sql
create table transcriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  device_id   uuid references devices(id),
  text        text,                               -- 允许为空（默认不保存）
  audio_size  int,
  duration_ms int,
  created_at  timestamptz default now(),
  deleted_at  timestamptz                          -- 软删除
);

alter table transcriptions enable row level security;
create policy "users manage own transcriptions"
  on transcriptions for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

---

## 7. Edge Function `/transcribe`

### 7.1 职责

- 校验 JWT（Supabase Auth 内置）
- 校验 MIME 类型（仅接受 `audio/ogg`, `audio/m4a`, `audio/mp4`, `audio/wav`）
- 校验文件大小（≤ `usage_limits.max_audio_size_bytes`）
- 校验录音时长（≤ `usage_limits.max_audio_seconds`）
- 频率限制（≤ `usage_limits.rate_limit_per_minute`）
- 查询剩余额度（当日 + 当月已用秒数）
- 根据上传文件 MIME 映射腾讯 ASR `VoiceFormat`
- 调用腾讯 ASR
- 记录 `usage_event`（成功和失败都记录）
- 返回转写文本或错误

### 7.2 MIME → VoiceFormat 映射

| 上传 MIME | VoiceFormat | 来源平台 |
|-----------|-------------|---------|
| `audio/ogg` | `ogg-opus` | Android (opus-media-recorder) |
| `audio/m4a` | `m4a` | iOS Safari |
| `audio/mp4` | `m4a` | iOS Safari (兼容) |
| `audio/wav` | `wav` | 备选（浏览器端转码后） |

### 7.3 限额校验流程

```sql
-- 当日已用秒数
select coalesce(sum(audio_duration_ms) / 1000, 0)
from usage_events
where user_id = :userId
  and status = 'success'
  and created_at >= date_trunc('day', now());

-- 当月已用秒数
select coalesce(sum(audio_duration_ms) / 1000, 0)
from usage_events
where user_id = :userId
  and status = 'success'
  and created_at >= date_trunc('month', now());

-- 最近一分钟请求数
select count(*)
from usage_events
where user_id = :userId
  and created_at >= now() - interval '1 minute';
```

超任一限制则返回 `429 Quota Exceeded`，记录 `status = 'rejected'`。

---

## 8. 设备绑定与注册

1. 用户在手机端注册 Supabase 账号（email + password）
2. 用户下载桌面客户端（平台安装包）
3. 打开客户端，登录同一账号
4. 客户端调用 Supabase RPC 或直接 INSERT 注册设备到 `devices` 表
5. 客户端订阅 `user:{userId}:presence` 上报在线状态
6. 客户端订阅 `device:{userId}:{deviceId}` 消息通道
7. 手机端设置页通过 Presence 同步获取在线设备列表
8. 用户可以在手机端撤销（`status = 'revoked'`）不信任的设备

同一账号 = 同一 `user_id`，无需额外配对码。

---

## 9. 隐私策略

| 数据 | 默认行为 | 用户可控 |
|------|---------|---------|
| 录音音频 | 不保存（Edge Function 不持久化音频） | — |
| 转写文本 | 不保存（transcriptions.text 为 null） | 用户开启"历史记录"后保存 |
| 通话元数据 | 保存（usage_events: 时长、大小、状态、时间） | 不可关闭（计费需要） |
| 设备信息 | 保存（devices: 名称、平台、最后在线） | 可撤销设备 |

历史记录功能：
- 默认关闭
- 用户开启后，Edge Function 在 `transcriptions` 表写入 `text`
- 用户可一键删除所有历史记录（`deleted_at` 软删除，定期物理清理）

---

## 10. 桌面客户端（Electron）

### 10.1 上线前必须处理的事项

| 事项 | 平台 | 状态 |
|------|------|------|
| Apple Developer Program ($99/年) | macOS | 必须 |
| Developer ID Application 证书 | macOS | 必须（Gatekeeper 阻止未签名应用） |
| Notarization (公证) | macOS | 必须（Catalina+ 阻止未公证应用） |
| Hardened Runtime | macOS | 必须（公证前提） |
| 辅助功能权限引导 | macOS | 必须（模拟键盘输入需要） |
| macOS 16 剪贴板隐私适配 | macOS | 需关注（新 API，可能触发系统提示） |
| Windows 代码签名 (OV $129+/年) | Windows | 推荐（消除 SmartScreen 警告） |
| 自动更新 | macOS + Windows | macOS 需签名+公证才能正常工作 |

### 10.2 系统权限矩阵

| 操作 | macOS | Windows | Linux (X11) | Linux (Wayland) |
|------|-------|---------|-------------|-----------------|
| 写剪贴板 | 无需权限 | 无需权限 | 无需权限 | 无需权限 |
| 模拟键盘粘贴 | 辅助功能权限 (TCC) | 无需权限 | xdotool | ydotool (需 polkit) |
| 应用更新 | Gatekeeper | SmartScreen | 无 | 无 |

### 10.3 打包工具

推荐 **Electron Forge**（Electron 官方维护，代码签名更可靠）。electron-builder 的 Windows 签名行为不稳定，Electron 官方已明确不推荐。

### 10.4 备选方案：Tauri 2.0

如果团队愿意投入 Rust 学习成本，Tauri 2.0 是更优的长期选择：
- 安装包体积小 96%（~5-10MB vs ~150MB）
- 内存占用低 60-90%
- 内置系统托盘支持
- Rust 侧可用 `enigo`（键盘模拟）和 `arboard`（剪贴板）
- macOS 辅助功能权限仍需处理（系统限制，无法绕过）
- **风险**：WebView2 在旧 Windows 10 上可能未预装

---

## 11. 手机客户端路线

| 阶段 | 形态 | 说明 |
|------|------|------|
| Phase 1-5 | Web PWA | 快速验证核心功能，可从浏览器添加到主屏幕 |
| Phase 6 | Capacitor 封装 | 生成 iOS/Android 原生容器，调用原生 API |
| 后续 | App Store 分发 | TestFlight (iOS) + APK (Android)，再考虑正式上架 |

PWA 在 Phase 1-5 是主要手机客户端，但文档明确标注为过渡方案。

---

## 12. 项目结构

```
voicebridge/
├── src/
│   ├── public/                  # Web 前端（现有 PWA，Phase 1-3 修改）
│   │   ├── index.html
│   │   ├── app.js               # 现有 1172 行，修改录音格式适配 + Realtime
│   │   ├── style.css
│   │   ├── auth.js              # [新增] Supabase Auth UI
│   │   ├── realtime.js          # [新增] Realtime 通道管理、消息收发
│   │   └── manifest.json
│   ├── server/                  # 现有局域网服务（保留，不破坏）
│   │   ├── index.js
│   │   ├── asr/
│   │   └── routes/
│   └── agent/                   # [新增] 桌面客户端 (Electron/Tauri)
│       ├── main.js
│       ├── preload.js
│       ├── renderer/
│       ├── realtime.js          # Realtime 订阅 + 消息处理
│       ├── clipboard.js         # [复用] 现有代码
│       ├── paste.js             # [复用] 现有代码
│       └── package.json
├── supabase/
│   ├── functions/
│   │   └── transcribe/
│   │       └── index.ts         # [新增] Edge Function (ASR 代理)
│   └── migrations/              # [新增] SQL 迁移
├── shared/                      # [新增] 跨端共享协议定义
│   └── protocol.js              # 消息类型、Realtime channel 命名
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-05-31-saas-auth-design-v2.md  (本文档)
└── package.json
```

---

## 13. 实施阶段（修正）

| Phase | 内容 | 关键依赖 | 估时 |
|-------|------|---------|------|
| **Phase 0** | 技术 spike：音频格式兼容性验证 | 无 | 2-3 天 |
| **Phase 1** | Auth + 设备注册 + 设备列表 | Supabase 项目已创建 | 1 周 |
| **Phase 2** | ASR Edge Function + 额度控制 | Phase 0 spike 通过 | 1 周 |
| **Phase 3** | Realtime 设备路由 + ack | Phase 2 | 4-5 天 |
| **Phase 4** | Desktop Agent MVP (CLI/Electron 精简版) | Phase 3 | 1 周 |
| **Phase 5** | Electron 正式客户端（托盘、签名、公证、自动更新） | Phase 4 | 2-3 周 |
| **Phase 6** | Capacitor 封装手机 App | Phase 5 | 1-2 周 |

**Phase 0 详情：**
- 用 `opus-media-recorder` 在 Android Chrome 录制 ogg-opus，发腾讯 ASR，评估识别质量
- iOS Safari 录制 m4a (48kHz)，发腾讯 ASR，评估识别质量
- 对比 16kHz WAV 基线
- 测试 Edge Function POST 请求体大小实际限制
- 测试 Supabase private Realtime + RLS 授权
- 输出 spike 结论，决定正式音频适配方案

**Phase 1 里程碑：** 用户注册/登录、看到设备列表（空）、验证 Supabase 连接链。

**Phase 0 阻塞项：** 如果 spike 发现 ogg-opus 或 m4a 直传质量不达标，需要选择备选方案（浏览器端 WAV 转码 或 独立转码服务），这会影响 Phase 2 的设计和时间。

---

## 14. 安全设计

| 层面 | 措施 |
|------|------|
| 认证 | Supabase Auth JWT，所有 API 访问需有效 token |
| 数据隔离 | 所有表启用 RLS，`user_id = auth.uid()` |
| Realtime | Private channel + `realtime.messages` RLS 策略；禁用 public access |
| 设备路由 | Per-device channel + `target_device_id` 校验，多桌面端互不干扰 |
| ASR 密钥 | Edge Function secrets，永不到达客户端或桌面端 |
| 音频上传 | JWT 校验 + MIME 白名单 + 大小限制 + 额度校验 |
| 频率限制 | 每用户每分钟 N 次请求（`usage_limits.rate_limit_per_minute`） |
| Storage | 仅认证用户可上传，音频 MIME only，24h 自动过期 |
| 隐私 | 默认不保存音频和转写文本，历史记录需用户主动开启 |

---

## 15. 与 v1 的差异摘要

| 条目 | v1 | v2 | 原因 |
|------|----|----|------|
| Realtime channel | `device-{userId}` 单频道 | `device:{uid}:{deviceId}` per-device | 防止多桌面端同时收到消息 |
| Realtime 安全 | 仅频道名包含 userId | private channel + `realtime.messages` RLS | 防止频道名猜测和越权 |
| 腾讯 ASR webm | 声称支持 | **不支持**，必须 ogg-opus | 事实错误修正 |
| 音频转码 | Edge Function 用 ffmpeg | 客户端侧格式适配 | Deno 无子进程，ffmpeg.wasm 超限 |
| 音频链路 | Storage → Edge Function | 短音频直 POST，长音频 Storage 兜底 | 统一主路径，消除矛盾 |
| ASR 成本控制 | 无 | usage_events + usage_limits + 频率限制 | 防止滥用 |
| 转写文本 | 默认保存 | 默认不保存，用户开启才保存 | 隐私保护 |
| 设备表 | 5 字段 | 11 字段（类型、版本、状态等） | 支持更完整的设备管理 |
| 消息协议 | 无 request_id | request_id + ack | 可靠性和状态反馈 |
| Phase 0 | 无 | 音频格式 spike | 必须在开发前验证关键假设 |
| 桌面端复杂度 | 仅说 "Electron" | 签名、公证、权限、Tauri 备选 | 上市前必须处理 |
| PWA 定位 | "Phone client" | 明确标注为过渡方案 | 避免误解为最终方案 |
