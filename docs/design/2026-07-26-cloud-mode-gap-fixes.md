# VoiceBridge 云端模式断层修复设计文档

> **作者**：lin
> **日期**：2026-07-26
> **状态**：已决策，待实施
> **关联历史**：从 LAN 模式迁到 cloud 模式时，前端搬过去了，但部分后端能力没有对应云端实现，导致功能缺失。

---

## 1. 问题清单与根因

| # | 问题 | 影响范围 | 根因分类 |
|---|------|---------|---------|
| 1 | 指令库加载失败（"加载指令失败"） | 所有 cloud 用户 | **架构断层**：`/api/commands` 是 LAN Express 提供的，cloud 没迁 |
| 2 | 粘贴/回车/Esc/撤销/删除 5 个按钮全失效 | 所有 cloud 用户 | **架构断层**：5 个按钮只走 LAN WebSocket 分支，cloud 没接 |
| 3 | 识别变慢（明显比 LAN 慢） | 所有 cloud 用户 | **架构代价**：多 1 跳公网 + base64 重编码 + 4 次串行 DB 往返 |
| 4 | 只能识别当前光标窗口，无法多窗口切换 | 所有 cloud 用户 | **架构代价**：窗口枚举是本地服务器能力，cloud 没有对应通道 |

下文逐项给出**确定的实施步骤**。

---

## 2. 修复项 1：指令库云端化

### 2.1 数据模型决策（关于用户问的"建一张表还是分两张"）

**结论：两张表，分而治之。**

- **`command_presets`**（全局只读，所有用户共享）— 系统内置的快捷指令清单
- **`user_commands`**（每用户私有，行级 RLS）— 用户自己加的、修改的、收藏的

#### 为什么不单表 + `is_builtin` 字段

| 方案 | 优点 | 缺点 |
|------|------|------|
| 单表 + `source='builtin'/'user'` 字段 | 实现简单 | 内置行必须写进每个新用户账上（要么 trigger 复制、要么 RLS UNION），数据冗余、升级困难 |
| **双表（推荐）** | 内置表只有一份，升级只改一次；用户私有表只为已注册用户占空间 | UNION 查询需要前端做合并 |
| 单表 + `required_plan` 字段（不区分 builtin/user） | 简单 | 用户能编辑/删除内置命令，违反"预置订阅解锁"的业务意图 |

#### Schema

```sql
-- 全局只读：内置预设指令库（不分用户）
create table public.command_presets (
  id            text primary key,                          -- 稳定 ID，如 'ps-portrait-001'
  label         text not null,
  text          text not null,
  category      text not null default 'uncategorized',
  sort_order    integer not null default 0,
  required_plan text not null default 'free'               -- 'free' | 'pro'
                check (required_plan in ('free','pro')),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
-- 不开 RLS（或开但全用户 SELECT，authenticated 才能读）

-- 用户私有：每个用户一份（可编辑、可删除、可收藏）
create table public.user_commands (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text not null,
  text        text not null,
  category    text not null default 'uncategorized',
  sort_order  integer not null default 0,
  is_favorite boolean not null default false,
  preset_id   text references public.command_presets(id) on delete set null,
                                                -- 如果用户"复制"了某条 preset 到自己库里
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
-- RLS：user_id = auth.uid()，标准 user-scoped 模式
```

### 2.2 套餐 gating（Plan Gating）策略

**核心问题**：当 pro 用户降级到 free 后，原本可见的 pro 预置指令怎么办？

**决策**：
- **不在数据库层过滤** `required_plan`，让 `command_presets` 全表对 authenticated 开放 SELECT
- **在 Edge Function（或 PWA 端）层过滤**：根据 `subscriptions.status` 判定 `plan`，过滤掉 `required_plan='pro'` 而当前 plan='free' 的行
- 好处：降级后用户能看到"解锁需要 Pro"的占位，比"突然消失"的体验更好；PWA 可以把锁定项灰显

**用户私有表 `user_commands` 不做 plan gating**——用户自己加的指令，永远可见（已收藏过的预设快照也应保留）。

### 2.3 数据迁移策略（关键）

现有 `hosted-pwa/public/commands.json` 里约 105 条命令混合了内置预设和用户自定义。迁移时按 **ID 前缀约定**：

| ID 前缀 | 含义 | 去向 |
|---------|------|------|
| `a1b2c3d4-*` | 开发协作预设 | → `command_presets`（`required_plan='pro'`） |
| `b1c2d3e4-*` | AI 绘图预设 | → `command_presets`（`required_plan='pro'`） |
| `cc-*` | CopyClaw skill 系 | → `command_presets`（`required_plan='pro'`，分隔符 `cc-sep-*` 也算） |
| `rs-*` | 科研 skill 系 | → `command_presets`（`required_plan='pro'`） |
| `ps-*` | PS 人像精修 | → `command_presets`（`required_plan='pro'`） |
| 其他（含 UUID） | 用户自定义 | → 不迁。新用户从空 `user_commands` 开始 |
| `Personal/*` | 含密码、邮箱等个人数据 | **不迁**（这些是 lin 个人调试时塞的，不应进 production） |

**回退方案**：迁移期间 `hosted-pwa/public/commands.json` 保留作为 LAN 模式 fallback；`/api/commands` endpoint 在 cloud 模式下返回合并视图。

### 2.4 PWA 端实现路径

1. `hosted-pwa/public/app.js:621` 的 `fetch("/api/commands")` 改成调 Supabase Edge Function `GET /functions/v1/commands`
2. Edge Function 内部：
   - 读 `command_presets` 全表
   - 读 `user_commands` where `user_id = auth.uid()`
   - 按 plan 过滤 preset 的 `required_plan`
   - UNION 返回，标记每条的 `source: 'preset' | 'user'`
3. PWA 端对 `source='preset'` 的行**禁用编辑/删除按钮**（UI 层保护，DB 层靠 RLS 双重保护）
4. 新建/编辑/删除走 `POST/PUT/DELETE /functions/v1/commands`，只操作 `user_commands`

### 2.5 LAN 模式兼容

**LAN 模式继续用本地 `commands.json`**，不强制走 Supabase——保持离线可用。未来可加可选的"云同步"，但本设计不涉及。

---

## 3. 修复项 2：5 个按钮云端化（粘贴 / 回车 / Esc / 撤销 / 删除）

### 3.1 协议设计

`shared/protocol.js` 已有 `MESSAGE_TYPES.KEY = "key"` 常量（但零引用）。补齐 schema：

```js
// shared/protocol.js 扩展
isKeyMessage(payload, myDeviceId) {
  if (!payload || payload.type !== MESSAGE_TYPES.KEY) return false;
  if (payload.request_id && typeof payload.request_id !== "string") return false;
  if (payload.source_device_id !== myDeviceId + "-reverse") return false;  // 注意：和 insert_text 反向
  if (payload.target_device_id !== myDeviceId) return false;
  const ALLOWED_KEYS = ['paste','enter','escape','undo','delete','ctrl-c',
                        'arrow-up','arrow-down','arrow-left','arrow-right'];
  return ALLOWED_KEYS.includes(payload.key);
}
```

**payload 形状**：
```ts
type KeyMessage = {
  type: 'key',
  request_id: string,          // 给 ack 用
  source_device_id: string,    // PWA 的 phoneDeviceId
  target_device_id: string,    // 桌面 deviceId
  key: 'paste' | 'enter' | 'escape' | 'undo' | 'delete' | 'ctrl-c'
     | 'arrow-up' | 'arrow-down' | 'arrow-left' | 'arrow-right',
  // 后续可扩展：modifiers?: ['shift' | 'ctrl' | 'cmd']
}
```

### 3.2 三层实施步骤

**Layer 1：协议层（`shared/protocol.js`）**
- 加 `isKeyMessage` 校验
- 加 `ALLOWED_KEYS` 常量
- 加 `buildKeyMessage({ sourceDeviceId, targetDeviceId, key })` 工厂函数

**Layer 2：PWA 发送侧（`hosted-pwa/public/cloudRealtime.js`）**
- 加 `sendKey({ targetDeviceId, keyType })` 方法（仿 `sendText` 第 69-101 行）
- 走同一个 `event: "command"` 广播通道，只是 `payload.type` 用 `'key'` 而不是 `'insert_text'`

**Layer 3：PWA UI 侧（`hosted-pwa/public/app.js:1089-1142`）**
- 把 5 个按钮的点击处理器从"只走 `ws`"改成：
  ```js
  if (isCloudMode) {
    cloudRealtime.sendKey({ targetDeviceId: selectedDeviceId, keyType: 'paste' });
  } else if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'paste' }));
  } else {
    showToast('发送失败，请检查连接。', true);
  }
  ```
- 同样的逻辑适用于：粘贴、回车、Esc、撤销、删除、Ctrl+C、方向键（如有）

**Layer 4：桌面接收侧（`src/agent/realtimeAgent.js`）**
- 改造 `handleDesktopMessage`：在 `isInsertTextMessage` 之外加 `isKeyMessage` 分支
- 根据 `payload.key` 调 `src/server/input/paste.js` 已有的函数：
  | `payload.key` | 调用 |
  |--------------|------|
  | `'paste'` | `pasteClipboard()` |
  | `'enter'` | `pressEnter()` |
  | `'escape'` | `pressEscape()` |
  | `'undo'` | `pressUndo()` |
  | `'delete'` | `pressDelete()` |
  | `'ctrl-c'` | `pressCtrlC()` |
  | `'arrow-up'` 等 | `pressArrow(direction)` |
- **发 ack 回 PWA**（参考 insert_text 的 ack 流程，复用 `MESSAGE_TYPES.ACK`）

### 3.3 LAN 协议 vs Cloud 协议不一致问题

LAN 用扁平字面量 `{type:"enter"}`，cloud 用 `{type:"key", key:"enter"}`。

**决策**：**统一用 cloud 协议**，LAN WebSocket 服务端（`src/server/ws.js`）也改成接收 `{type:"key", key:"..."}`。这样代码、文档、测试都只剩一套。LAN 端旧客户端不做兼容（用户都得升级）。

### 3.4 关于 ack

5 个按钮目前 LAN 模式不发 ack，cloud 模式**要不要发 ack**？

**决策**：发。原因：
- 桌面按键可能失败（osascript 报权限错、xdotool 未安装等）
- 没 ack PWA 就只能"乐观更新" toast，体验差
- ack payload 复用现有 `MESSAGE_TYPES.ACK` schema，加个 `key` 字段就行

---

## 4. 修复项 3：识别延迟优化（针对用户问"为什么慢这么多"）

### 4.1 LAN vs Cloud 延迟构成对比（同一 3 秒录音）

| 阶段 | LAN | Cloud | 差值 |
|------|-----|-------|------|
| 录音停止 + 编码 | 5-20 ms | 20-80 ms（JS 重采样） | +15-60 ms |
| 上传 | 10-50 ms（局域网） | 80-300 ms（公网） | **+70-250 ms** |
| Edge Function 冷启动 | 0 | 0-300 ms（首次） | +0-300 ms |
| Edge 内部 DB 往返 | 0 | 4 次 ≈ 130-360 ms | **+130-360 ms** |
| base64 编码 | 1-3 ms | 3-10 ms | ~0 |
| 调腾讯 ASR | 300-1500 ms（本地 Node→腾讯） | 300-1500 ms（Supabase Edge→腾讯） | 视链路而定 |
| 更新用量 | 同步 <5 ms | 异步 30-80 ms（当前是 await） | **+30-80 ms** |
| 响应回 PWA | 10-50 ms | 30-100 ms | +20-50 ms |
| **合计中位** | **~700-900 ms** | **~1100-1500 ms** | **+400-700 ms** |

**Cloud 比 LAN 慢 400-700ms 的来源**：公网上传差（70-250 ms）+ Edge 内部串行 DB（130-360 ms）+ Edge 到腾讯的链路（不确定）+ 当前 `updateReservedUsage` 是 await（30-80 ms）。

### 4.2 优化方案（按 ROI 排序）

#### P0：必做，立竿见影

| 优化项 | 预期收益 | 实施成本 |
|--------|---------|---------|
| **O1**: `updateReservedUsage` 改为 fire-and-forget（不 await） | 省 30-80 ms | 1 小时 |
| **O2**: 合并 `getSubscription` + `reserveTranscribeUsage` 为单个 RPC | 省 30-80 ms | 半天 |
| **O3**: Edge Function 加腾讯调用 AbortController(10s) + 重试 | 改善 P99，平均不变 | 1 小时 |

**累计 P0 收益：60-160 ms，零风险**

#### P1：高收益，需验证

| 优化项 | 预期收益 | 实施成本 | 风险 |
|--------|---------|---------|------|
| **O4**: 切换腾讯 `FlashRecognition` Action | 省 200-500 ms | 半天 + 验证 | 需确认腾讯账号开通此服务 |
| **O5**: 浏览器 `new AudioContext({ sampleRate: 16000 })` 硬件重采样 | 省 20-80 ms + 提升准确率 | 半天 | 浏览器兼容性需测 |
| **O6**: Edge Function 内缓存 plan（user_id → plan，TTL 60s） | 省 30-80 ms（第二次起） | 半天 | plan 变更延迟最多 60s |

**累计 P1 收益：250-660 ms**

#### P2：需较大投入

| 优化项 | 预期收益 | 实施成本 |
|--------|---------|---------|
| **O7**: PWA 直连腾讯（签名接口方案）—— Edge Function 只签 TC3-HMAC 头，浏览器直接 POST 腾讯 | 省 200-500 ms | 1-2 天（需验证腾讯 API CORS） |
| **O8**: AudioWorklet 替换 ScriptProcessor | 不卡 UI，省 10-30 ms | 1 天 |
| **O9**: 实时流式 ASR（腾讯 WebSocket） | 巨大 UX 改进（边说边显示） | 1 周 |

> **注**：原 P2 候选"让 LAN 也改浏览器产 WAV（跳过 ffmpeg）"已决定**不做**——见 §7.2 决策 4。

### 4.3 推荐落地节奏

**阶段 1（本周）**：P0 全做 → Cloud 延迟从 ~1200ms 降到 ~1050ms
**阶段 2（下周）**：P1 验证并落地 → Cloud 延迟降到 ~600-800ms（接近 LAN）
**阶段 3（后续）**：P2 按用户反馈决定，实时 ASR 是长期方向

---

## 5. 修复项 4：多窗口支持云端化

### 5.1 现状回顾

- LAN 模式有 `WindowSelector` 类（`hosted-pwa/public/app.js:402-436`），通过 `/api/windows` 拉桌面端窗口列表
- cloud 模式完全没接，下拉里只显示设备列表（基于 presence）

### 5.2 决策：用 Presence state 上报窗口列表

**为什么不另开 channel？** 多开一个 channel 等于多一份订阅成本、多一次 RLS 评估、多一次配对验证。窗口列表变化频率低（用户切窗口不是高频操作），塞进 presence track state 完全够。

#### 协议扩展

桌面 agent 在 `presence.track()` 时附带 `windows` 字段：

```js
// src/agent/electron/main.js 或 realtimeAgent.js
await presence.track({
  deviceId: device.id,
  platform: device.platform,
  device_type: 'desktop',
  windows: await listDesktopWindows(),  // 新增
  // 例如: [{ id: 'win-123', title: 'VSCode', app: 'Code', active: true },
  //        { id: 'win-456', title: 'Terminal', app: 'Terminal', active: false }]
});
```

#### PWA 端改造

`cloudRealtime.js` 的 `presence.on('sync', ...)` 回调里把 `windows` 数组透传给 PWA。`app.js:242` 的 `renderCloudDeviceOptions` 改成"设备 + 窗口"两级渲染：

```
[设备] MacBook Pro (lin)
   ├── 当前光标位置
   ├── VSCode
   └── Terminal
```

#### 桌面端实现

桌面 agent 启动时定时枚举窗口（macOS 用 `osascript -e 'tell application "System Events" to get ...'`），变化时刷新 presence state。频率建议 1-2 秒一次，避免性能开销。

### 5.3 窗口定位实现路径（用户选了某个窗口后）

1. PWA 发送 `insert_text` 时附带 `target_window_id`
2. 桌面 agent 收到后：先 `osascript ... activate window X`，再 `pasteClipboard()`
3. 这部分逻辑在桌面端 `paste.js` 加一个 `activateWindow(windowId)` 函数

### 5.4 隐私权衡

上报窗口列表等于把用户当前打开的应用/标题传到 presence（云端）。**决策**：

- 默认**只上报 app 名和 windowId**，不上报窗口标题
- 在桌面端设置里加开关"上报窗口标题"，默认关闭
- Pro 用户可以解锁"完整窗口标题"以获得更精准定位

---

## 6. 实施路线图（综合 4 项）

```
Week 1
├── 修复项 2 - 5 个按钮云端化（最快，影响最大）
│   ├── Layer 1: protocol.js 扩展 (0.5 day)
│   ├── Layer 2: cloudRealtime.sendKey() (0.5 day)
│   ├── Layer 3: PWA UI 适配 (0.5 day)
│   └── Layer 4: 桌面 agent 处理 KEY (1 day)
├── 修复项 3 - P0 优化 (1 day)
│   ├── updateReservedUsage fire-and-forget
│   ├── 合并 getSubscription + reserve RPC
│   └── Edge Function 超时控制
└── 修复项 1 - 指令库云端化（设计已就绪，工程量较大）
    ├── 数据库 schema + 迁移 (1 day)
    ├── Edge Function /functions/v1/commands (1 day)
    ├── PWA 端切换 (0.5 day)
    └── 旧数据迁移脚本 (0.5 day)

Week 2
├── 修复项 3 - P1 优化 (验证 + 落地，2-3 day)
│   ├── FlashRecognition 试点
│   ├── AudioContext sampleRate
│   └── Plan 缓存
├── 修复项 4 - 多窗口支持 (2-3 day)
│   ├── Presence state 扩展
│   ├── 桌面端窗口枚举
│   └── PWA 下拉两级渲染
└── 端到端测试

Week 3+
└── P2 优化（按用户反馈优先级）
    ├── PWA 直连腾讯 ASR
    ├── AudioWorklet 重构
    └── 实时流式 ASR

> LAN 模式相关改造（如浏览器产 WAV、跳过 ffmpeg）**不在路线图内**，保持 LAN 现状。
```

---

## 7. 风险与未决问题

### 7.1 风险

| 风险 | 缓解措施 |
|------|---------|
| 腾讯 FlashRecognition 未开通或换 API 限速 | P1 先试点 1 周再全面切换；保留 SentenceRecognition fallback |
| `commands` 表 schema 与现有 commands.json 不完全兼容 | 迁移时只搬字段对得上的；`Personal/*` 不搬 |
| Presence state 携带 windows 数组过大（用户开 30 个窗口） | 单 presence state 限制 4KB，超过时只传前 10 个活跃窗口 |
| 桌面 agent 老版本无法处理 KEY 消息 | PWA 端检测桌面 app_version，老版本降级提示用户升级 |

### 7.2 已决策事项（用户拍板）

1. **指令库套餐策略**：
   - **free 用户可见 10 条基础预设**（从现有预设中精选）
   - **pro 用户解锁所有**（PS、CC、RS、AI 绘图、开发协作全套）
   - 精选清单在迁移脚本里按 `required_plan` 字段标注，可在 SQL 里调整
2. **降级体验**：Pro 用户降级后，他"收藏过"的 Pro 预设**保留可读快照**到 `user_commands.preset_id`，**UI 灰显**并提示"升级 Pro 后可用"。这样：
   - 用户的收藏不会突然消失（避免"我加过的东西被偷走"的感受）
   - 灰显作为转化触点（看到 Pro 功能多但用不了，刺激升级）
   - 数据库实现：`user_commands` 不做 plan gating，所有收藏永远可读；显示层根据当前 plan 判定是否灰显
3. **窗口上报隐私**：默认**只上报 app 名 + windowId**，不上报窗口标题。桌面端设置加开关"上报窗口标题"（默认关闭），未来可作 Pro 功能。
4. **音频格式统一（LAN 是否同步改浏览器产 WAV）**：

   **决策：暂不动 LAN。** 理由：

   - 当前 LAN 模式工作稳定，用户报告"延迟还可以接受"
   - 同步改造需要改 LAN 的 PWA 录音器、上传协议、`upload.js` 路由、`transcriber.js`，触及面广
   - 改完之后 LAN 和 Cloud 表面上走同一条格式路径，但 Edge Function 内部还有 plan gating、DB 往返等差异，**并没有真正统一架构**
   - 引入"浏览器产 WAV"这件事，等以后整体重构 ASR 链路（比如 P2 阶段做 PWA 直连腾讯或流式 ASR）时一起做更优雅

   **取舍原则**：宁可不优化，也不要为了省 80-230ms 引入额外的复杂度。如果优化不能让架构变得更简单、更优雅，那它就不值得现在做。当前的痛点是"云端慢"，优化重心放在 Cloud 路径，LAN 保持现状。

---

## 8. 附录：相关文件索引

### 8.1 修复项 1 涉及
- `src/server/routes/commands.js` — LAN 现状
- `hosted-pwa/public/commands.json` — 待迁移数据
- `hosted-pwa/public/app.js:536-735` — CommandLibrary 类
- `hosted-pwa/public/app.js:621` — `fetch("/api/commands")` 调用点
- `supabase/migrations/0001_cloud_core.sql` — 现有用户表参考
- `docs/superpowers/specs/2026-05-31-saas-auth-design.md:104-115` — 旧设计中的 commands 表

### 8.2 修复项 2 涉及
- `src/shared/protocol.js:1-5` — MESSAGE_TYPES 常量（KEY 已存在但零引用）
- `hosted-pwa/public/app.js:1089-1142` — 5 个按钮的 LAN-only 处理器
- `hosted-pwa/public/cloudRealtime.js:69-101` — sendText 参考实现
- `src/agent/realtimeAgent.js:5-43` — handleDesktopMessage（只处理 INSERT_TEXT）
- `src/server/input/paste.js` — 键注入函数库（osascript/powershell/xdotool）

### 8.3 修复项 3 涉及
- `supabase/functions/transcribe/index.ts:69-109` — Edge Function 主流程
- `supabase/functions/_shared/tencent_asr.ts:1-4` — 当前 SentenceRecognition Action
- `supabase/functions/_shared/plan_limits.ts` — 套餐限制
- `src/public/cloudRecorder.js` — ScriptProcessor 录音（已废弃 API）
- `src/public/wavEncoder.js:32-40` — 最近邻重采样（低质量）

### 8.4 修复项 4 涉及
- `hosted-pwa/public/app.js:402-436` — WindowSelector 类（LAN only）
- `hosted-pwa/public/cloudRealtime.js:47-52` — presence sync 回调（扩展点）
- `hosted-pwa/public/cloudRealtime.js:268-274` — isDesktopDeviceCandidate（需联动改造）
