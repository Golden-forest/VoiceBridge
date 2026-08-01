# 云端 ASR 功能对齐与低延迟架构设计

**日期：** 2026-08-01

**文档版本：** v3

**状态：** 已按现有代码、腾讯云接口限制与 Supabase Edge Function 运行边界复核；v3 根据 sub-agent 审查报告修正 filler 正则边界 bug、补全文件清单、明示 3 个技术决策（deadline、import 路径、字段命名），可进入实施计划

**v2→v3 变更摘要：**
- admin 上限确认为 60 秒（用户确认），UI 显示真实值，不显示 ∞。
- filler 正则修正：v2 的正则对"普通汉字+语气词+标点"模式无效（如"你好嗯嗯嗯，世界"漏删），且会产生重复标点。v3 改为更精确的匹配+清理链。
- spec 4.3 总 deadline 补具体数值：总 12 秒，Flash 单次 8 秒，剩余 ≥ 3 秒才 fallback。
- spec 6.1 明示 import 路径方案：复用 `protocol.js` 的 `../shared/planLimits.js` + build 归一化。
- spec 4.7 明示 migration 字段改名：`max_audio_seconds` → `max_audio_ms`。
- spec 13 补全遗漏文件：`cloudTranscribe.js`、`wav.ts`、`cors.ts`、`i18n/i18n.js`、多个测试文件。
- spec 5.2 AudioWorklet 明确标注"本轮不做，留作独立后续任务"。
- spec 12 Phase 0/1 依赖关系明示。
- 修正 spec 8 typo。

---

## 1. 结论摘要

本次目标不是机械复制 LAN 逻辑，而是在保持两端用户行为一致的前提下，保护“停止录音 → 电脑出现文字”这条关键路径。

确定采用以下决策：

1. **立即对齐云端 ASR 参数和后处理**，但不照搬 LAN 中会误删正常词语的正则缺陷；LAN 与 Cloud 同时改为同一组保守规则和契约测试。
2. **录音上限固定为 free 15 秒、pro 60 秒、admin 60 秒**。达到上限时前端自动结束录音，并正常上传、识别已经录到的前 15/60 秒；用户不会先录完再收到拒绝。
3. **推翻“录音上限减 5 秒给上传留余量”**。上传和编码耗时不会增加 WAV 内的音频时长；客户端按真实上限停止，并通过采样数保证不越界。
4. **不设计超过 60 秒的录音能力**。不做长音频上传、自动分段、实时 ASR 或长连接 relay。
5. **不移植 2.8 秒空闲缓冲**。任何人为等待都会直接损害核心体验；普通识别结果立即输出。
6. **不增加新的前台数据库或网络往返**。后端继续使用一次 `reserve_and_get_plan()` 原子 RPC；用量收尾异步执行。
7. **建立可测量的延迟预算和 Server-Timing**。没有分段指标就不能证明“零延迟影响”。

最终产品规则保持简单：一次录音、达到上限自动停止、一次上传、一次识别、一次输出。

---

## 2. 现状核对

### 2.1 已经对齐的能力

根据当前代码，以下能力已经在 Cloud 模式落地，不应在本设计中重复建设：

| 能力 | LAN | Cloud | 结论 |
|---|---|---|---|
| 文本发送到指定桌面设备 | WebSocket | Supabase Realtime | 已对齐 |
| 自动粘贴与剪切板兜底 | 本地 outputText | desktop realtime agent | 已对齐 |
| Enter / Esc / Undo / Delete 等按键 | LAN WebSocket | `sendKey()` + ack | 已对齐 |
| 桌面设备与窗口选择 | 本地 API | Presence + `target_window_id` | 已对齐 |
| 指令库读取和用户指令 | 本地 commands | Cloud command store | 已有云端实现 |
| 发送结果确认 | 本地 output 消息 | Realtime ack | 已对齐 |

### 2.2 仍未对齐或存在风险的能力

| # | 差异或风险 | 当前影响 | 本次处理 |
|---:|---|---|---|
| 1 | Flash `filter_modal=0` | 云端保留更多语气词 | 必做 |
| 2 | SentenceRecognition 未显式传 4 个过滤参数 | fallback 行为与 LAN 不一致 | 必做 |
| 3 | Cloud 无二次 filler 清理 | 同一段音频两端结果不同 | 必做 |
| 4 | LAN filler 正则会误删“哼唱”“啧啧称奇” | 对齐旧实现会复制 bug | LAN/Cloud 一起修正 |
| 5 | 前端固定 55 秒，套餐上限未进入录音状态 | UI 与后端配额不一致 | 必做 |
| 6 | 当前 admin cache fast path 跳过 RPC | 可能跳过单次时长校验和 usage reservation | 必须删除 |
| 7 | `ScriptProcessor` + 停止后整段 Float32 拼接、重采样和 WAV 编码 | 停止录音后主线程额外等待，60 秒录音时更明显 | 本轮测量；只在指标超标时优化 |
| 8 | Flash 失败后一律 fallback | timeout 时可能先等 10 秒再走第二条请求 | 增加总 deadline 和错误分类 |
| 9 | `hosted-pwa` 镜像校验不覆盖录音、转写和 i18n | 本地修了，线上文件仍可能漏同步 | 必做 |
| 10 | Cloud 没有 LAN 的语音命令/跨录音缓冲 | 功能差异 | 本轮不加延迟缓冲；命令另行设计 |

### 2.3 当前关键路径

```text
用户松开录音
  → 主线程拼接 Float32 chunks
  → 主线程重采样为 16kHz PCM
  → 主线程生成完整 WAV Blob
  → PWA 上传 multipart/form-data
  → Supabase Edge Gateway + JWT claims 校验
  → req.formData() + audio.arrayBuffer()
  → 解析 WAV 时长
  → reserve_and_get_plan() 原子 RPC
  → Tencent FlashRecognition
      ↳ 失败时 SentenceRecognition fallback
  → ASR 后处理
  → Edge 返回 PWA
  → PWA 通过预热的 Realtime channel 发送文本
  → Desktop 写剪切板并粘贴
  → ack 返回 PWA
```

不能只测 Edge Function 的响应时间。用户感知延迟从松开录音开始，到文字真正出现在电脑输入框结束。

---

## 3. 延迟目标和约束

### 3.1 核心指标

定义：

- `T0`：用户触发停止录音。
- `T1`：WAV Blob 可上传。
- `T2`：Edge 收到完整请求。
- `T3`：配额 RPC 完成。
- `T4`：腾讯返回最终文本。
- `T5`：PWA 收到文本。
- `T6`：桌面端完成粘贴或剪切板写入。

核心指标为 `stop_to_desktop_ms = T6 - T0`。

| 指标 | P50 目标 | P95 目标 | 说明 |
|---|---:|---:|---|
| `encode_ms` (`T1-T0`) | ≤ 40ms | ≤ 120ms | 不允许随录音时长明显线性恶化 |
| `edge_pre_asr_ms` (`T3-T2`) | ≤ 150ms | ≤ 350ms | 含鉴权、解析和一次 RPC |
| `asr_ms` (`T4-T3`) | 先建立基线 | 先建立基线 | 按音频时长、provider path 分桶 |
| `response_ms` (`T5-T4`) | ≤ 120ms | ≤ 300ms | Edge → PWA |
| `desktop_delivery_ms` (`T6-T5`) | ≤ 180ms | ≤ 500ms | Realtime send + desktop output + ack |
| `stop_to_desktop_ms` | ≤ 1.2s | ≤ 2.5s | 以 3-8 秒普通话录音为基准 |

以上是验收预算，不是上线前虚构的承诺值。第一阶段先采集至少 100 次真实样本；如果腾讯 ASR 本身超过预算，应单独报告 provider 延迟，不用前端动画掩盖。

### 3.2 不得进入关键路径的操作

- 不在录音停止后重新查询 plan。
- 不在 ASR 返回后同步更新 usage event。
- 不等待 Realtime ack 才把文本显示在手机输入框。
- 不做 2.8 秒空闲 flush。
- 不在请求中做多次 ASR 重试或无上限 fallback。
- 不在主线程上对完整录音执行不必要的多次复制。

---

## 4. 本轮方案：批处理短录音对齐

### 4.1 ASR 参数统一

**文件：** `supabase/functions/_shared/tencent_asr.ts`

FlashRecognition 显式固定：

```ts
filter_dirty: "0",
filter_modal: "1",
filter_punc: "0",
convert_num_mode: "1",
```

SentenceRecognition 显式固定：

```ts
FilterDirty: 0,
FilterModal: 1,
FilterPunc: 0,
ConvertNumMode: 1,
```

这些值与 LAN 当前配置一致。两条 provider path 必须有请求构造单元测试，禁止依赖腾讯默认值。

### 4.2 后处理不复制 LAN 的误删 bug

原 LAN 实现使用字符类全局删除：

```js
/[嗯呃唔噢欸诶哼嘖啧]/g
```

该实现与“只删独立语气词”的注释不一致，会把“哼唱”“啧啧称奇”等正常词语破坏。云端不应为了表面对齐而复制错误。

改为两层策略：

1. 腾讯 `FilterModal=1` 负责第一层部分过滤。
2. 本地只删除位于句首、句尾或标点/空白边界之间的连续语气词；不删除普通词内部字符。

v3 正则修正（v2 的正则对"普通汉字+语气词+标点"模式无效，且会产生重复标点）：

核心设计：**语气词必须至少有一侧是边界（句首/句尾/标点/空白），才会被删除。** 两侧都是普通汉字时不删（避免破坏正常词）。

- 模式 A：`边界 + 语气词 + 任意字符` — 删除语气词，保留边界。
- 模式 B：`任意字符 + 语气词 + 边界` — 删除语气词，保留后随字符。

这两条交替匹配可以覆盖：
- "嗯，你好"（句首+filler+标点）→ 删
- "你好嗯嗯嗯，世界"（汉字+filler+标点）→ 删（模式 B）
- "你好嗯嗯嗯世界"（汉字+filler+汉字）→ 不删（保护正常词）

实现规则（TypeScript / Edge Function 版）：

```ts
// 模式 A：前导边界(捕获) + 语气词
const FILLER_LEADING = /(^|[\s，,。.!！？?、；;：:])(嗯+|呃+|唔+|噢+|欸+|诶+|哼+|嘖+|啧+)/gu;
// 模式 B：语气词 + 后置边界(捕获)
const FILLER_TRAILING = /(嗯+|呃+|唔+|噢+|欸+|诶+|哼+|嘖+|啧+)([\s，,。.!！？?、；;：:]|$)/gu;

export function removeFillerWords(text: string): string {
  if (!text) return text;
  return text
    .replace(FILLER_LEADING, "$1")              // 模式 A：保留前导边界
    .replace(FILLER_TRAILING, "$2")             // 模式 B：保留后置边界
    .replace(/([，,。.!！？?、；;：:])\1+/gu, "$1")  // 合并连续相同标点（如"，，"→"，"）
    .replace(/[ \t]{2,}/g, " ")                  // 合并连续空格
    .replace(/\s+([，,。.!！？?、；;：:])/gu, "$1")  // 删除标点前的空格
    .replace(/^[\s，,。.!！？?、；;：:]+/u, "")      // 删除开头的标点/空格
    .trim() || "";
}
```

> **注意**：模式 A 和模式 B 会重叠（两侧都是边界时两个模式都匹配）。先执行 A 再执行 B，A 已经删除了部分，B 对剩余的再清理，顺序不影响最终结果。

LAN 端（JavaScript / Node 版）使用相同逻辑，去掉类型注解即可。

**fixture 测试用例（两端共用，必须全部通过）：**

| 输入 | 期望输出 | 说明 |
|---|---|---|
| `"嗯，你好"` | `"你好"` | 句首 filler + 标点 |
| `"你好嗯嗯嗯，世界"` | `"你好，世界"` | 普通汉字+filler+标点（v2 漏删场景） |
| `"嗯嗯嗯你好"` | `"你好"` | 句首连续 filler，无标点 |
| `"你好，嗯嗯嗯，世界"` | `"你好，世界"` | 标点+filler+标点（v2 重复标点场景） |
| `"哼唱"` | `"哼唱"` | 正常词保留（LAN v1 bug 场景） |
| `"啧啧称奇"` | `"啧啧称奇"` | 正常词保留（LAN v1 bug 场景） |
| `""` | `""` | 空文本 |
| `"你好世界"` | `"你好世界"` | 无 filler |
| `"嗯嗯嗯"` | `""` | 全 filler |
| `"你好，世界嗯嗯嗯"` | `"你好，世界"` | filler 在句尾 |

实现要求：

- 后处理在 `transcribeTencentWav()` 的 **Flash 和 SentenceRecognition 两条路径各自的 return 之前**统一调用，确保不漏。
  - 推荐：提取为内部函数 `postProcessText(rawText: string): string`，两条路径各调一次。
- LAN `src/server/asr/transcriber.js` 同步采用相同行为（替换 `FILLER_RE` 字符类为上述边界匹配）。
- 两端跑同一份 fixture（上表 10 条）。
- 不删除"啊"，因为正常汉语词汇中出现频率高，误删风险更大。

### 4.3 Provider 路由和总超时

当前 Flash 任意失败都会 fallback，单次 Flash timeout 为 10 秒，最坏情况下用户先完整等待一次失败再开始 SentenceRecognition。

改为：

- `<= 60s`：Flash 为主，SentenceRecognition 只作为短音频 fallback。
- 正常录音由客户端在套餐上限处自动停止。后端的 `> 60s` 拒绝只处理绕过前端、计时器异常或手动构造的非法请求，不是正常用户流程。
- **总 deadline = 12 秒**（从 Edge 收到请求开始计时）。不再让每条 provider path 各拥有完整 10 秒。
- **Flash 单次 timeout = 8 秒**（从当前 10 秒缩短）。Flash 失败后剩余预算 ≥ 3 秒才允许 SentenceRecognition fallback。
- 对"服务未开通（如腾讯 code 4003）、参数不支持"等明确错误可立即 fallback，不消耗 timeout 预算。
- 对 timeout/网络错误，只有在总 deadline 尚有 ≥ 3 秒预算时才 fallback；不做第二轮 retry。
- 响应和日志记录 `provider=flash|sentence`、`fallback_reason` 和各阶段时长，但不记录音频或转写正文。

实现要点：

- `transcribeTencentWav()` 顶部记录 `const deadlineStart = Date.now()`。
- `fetchWithTimeout` 改为接受动态 timeout 参数（而非写死 10_000）。
  - Flash 调用传 `8_000`。
  - SentenceRecognition fallback 调用传 `Math.max(1000, 12_000 - (Date.now() - deadlineStart))`。
- 对 Flash 的 catch 块增加错误分类：
  - 若 `error.message` 包含明确的服务不可用关键词（如 `4003`、`not enabled`）→ 立即 fallback。
  - 若是 timeout/abort → 检查剩余预算是否 ≥ 3 秒。
  - 其他错误 → 检查剩余预算是否 ≥ 3 秒（保守策略）。

VoiceBridge 将 60 秒作为两条 provider path 的统一产品上限。腾讯 SentenceRecognition 官方限制为 60 秒内、3MB 内；即使 FlashRecognition 能处理更长音频，本项目也不开放该差异能力。

### 4.4 套餐与单次录音上限

本轮采用：

| Plan | monthlySeconds | batch maxAudioSeconds | rateLimitPerMinute | UI |
|---|---:|---:|---:|---|
| free | 600 | 15 | 10 | 最长 15 秒 |
| pro | 18000 | 60 | 30 | 最长 60 秒 |
| admin | 1_000_000 | 60 | 10_000 | 最长 60 秒 |

说明：

- admin 与 pro 使用相同的单次 60 秒上限；admin 的差异只体现在月额度和频率限制，不体现在单次录音时长。
- UI 必须显示真实限制，不显示 `∞`。
- plan 只影响最大录音时长和额度，不应改变同一段音频的 ASR 参数或文本质量。

### 4.5 录音停止不再减 5 秒

原方案把 free 15 秒变成实际 10 秒、pro 60 秒变成实际 55 秒，这是错误的产品语义。上传耗时不属于音频时长，不能从用户录音额度中扣除。

实现：

- `currentUserPlan` 只用于前端 UI 和提前停止；后端仍是唯一权威。
- `handleAuthState()` 已经读取 subscription，直接同步 `currentUserPlan`，不新增请求。
- plan 未加载时采用 free 作为安全默认；加载后立即更新提示。
- cloud recorder 接收 `maxDurationMs`，按已采集 PCM sample 数触发停止，避免后台标签页 timer throttling 造成越界。
- `setTimeout(maxDurationMs)` 只作为 UI/设备异常兜底，不负责精确计量。
- 后端直接按 WAV header 得到的毫秒数校验，不使用 `ceil(seconds)` 制造 15.01 秒变成 16 秒的边界误判。

`t()` 已确认支持函数型文案和 rest 参数，因此直接使用：

```js
reachedLimit: (sec) => `已到 ${sec} 秒上限，正在识别...`,
maxDurationHint: (sec) => `最长 ${sec} 秒`,
```

英文提供对应函数型 key，不在 `app.js` 内直接拼中英文字符串。

### 4.6 删除 admin fast path

当前 `transcribe/index.ts` 在命中 admin plan cache 后直接跳过 `reserve_and_get_plan()`。这会同时跳过：

- admin 状态重新确认；
- 单次时长校验；
- 原子 usage reservation；
- request 去重和频率保护。

当字节上限扩大时，这个问题会变得更严重。本设计删除 `isAdminFastPath`；所有 plan 每次请求都执行同一个原子 RPC。保留 60 秒 plan cache 只允许减少 RPC 内部 subscription 查询，不允许绕过 RPC 本身。

这会让命中旧 admin fast path 的请求恢复一次 RPC，但 free/pro 的关键路径不增加往返。该取舍用于修复真实的校验绕过；必须在 Phase 0 单独测量 admin 的 `reserve_ms`。若其 P95 超过 150ms，应优化 RPC 查询和索引，或另行设计录音期间完成的预授权 ticket，不能重新用跳过 reservation 的方式换延迟。

成功或失败后的 usage 状态更新使用 `EdgeRuntime.waitUntil()` 承接，不阻塞文本响应。不能只写裸 `void promise`，否则 isolate 可能在响应结束后提前退出。

### 4.7 数据库迁移规则

不得修改已经存在并可能部署过的 `0011_admin_plan.sql`。应通过 Supabase CLI 创建新的迁移，再使用 `create or replace function` 更新 `reserve_and_get_plan()`：

```text
supabase migration new align_cloud_asr_limits
```

新迁移需要：

- 将单次时长判断改为毫秒比较（不再使用 `ceil(ms/1000)`）。
- 将 free/pro/admin batch 上限改为 15000ms / 60000ms / 60000ms。
- **返回字段 `max_audio_seconds` 改名为 `max_audio_ms`**，内部值为毫秒。
  - `transcribe/index.ts` 的读取代码（当前 `data?.max_audio_seconds`）需同步改为 `data?.max_audio_ms`。
  - `reserve_and_get_plan()` 的返回 JSON 中用 `max_audio_ms` 替代 `max_audio_seconds`。
- **月额度累加改为毫秒级**：当前 `sum(ceil(audio_duration_ms::numeric / 1000))` 改为 `sum(audio_duration_ms)`，月额度 `monthlySeconds` 也换算为毫秒比较（`monthlySeconds * 1000`）。
- 保留 advisory lock、频率限制和 unique request 处理。
- 继续只向 `service_role` 授予 RPC execute 权限。
- 不使用用户可编辑的 metadata 判断 admin；继续读取受服务端控制的 subscription/profile 数据。

> **文件命名**：按现有序号，新 migration 应为 `supabase/migrations/0015_align_cloud_asr_limits.sql`（sub-agent 执行 `supabase migration new` 时会自动生成序号）。

### 4.8 音频大小校验

16kHz、16-bit、mono PCM WAV 约为 32KB/s：15 秒约 480KB，60 秒约 1.92MB。

本轮保持 3MB 绝对上限，不增加 25MB admin 分支。校验顺序：

1. 在读取 body 后立即做 3MB absolute byte limit。
2. 解析 WAV header，校验 PCM、mono、16-bit、16kHz 和 duration。
3. 调用原子 RPC 做 plan duration/quota/rate-limit reservation。

`parsePcmWavDurationMs()` 还应返回或配套校验音频格式字段，不能只计算 duration 后默认格式可信。

---

## 5. 停止后编码优化

### 5.1 当前问题

`cloudRecorder.js` 使用已废弃的 `ScriptProcessorNode`，录音时保存多个 Float32 chunk；停止后再：

1. 计算总长度；
2. 拼成一个大 Float32Array；
3. 最近邻重采样到 16kHz；
4. 再生成完整 PCM WAV ArrayBuffer。

这会产生多次整段内存复制，并把计算集中在用户已经停止说话之后。短音频影响有限，录音越长越明显。

### 5.2 推荐替换（本轮不实施）

> **v3 明示**：AudioWorklet 改造**不在本轮 Phase 1 范围内**。本轮 Phase 1 只在 `cloudRecorder.js` 增加 sample-count 停止机制。AudioWorklet 留作独立后续任务，待 Phase 0 测量数据证实 `encode_ms P95 > 120ms` 后再立项。

以下为未来实施时的设计参考：

在不改变后端协议的前提下，用 `AudioWorklet` 增量输出 16kHz Int16 PCM chunk：

- 录音过程中完成线性插值重采样和 Float32 → Int16 转换。
- 主线程只保存 Int16 ArrayBuffer chunks。
- 停止时创建 44-byte WAV header，然后 `new Blob([header, ...pcmChunks])`。
- 不再创建整段 Float32Array，也不在停止时重采样。
- AudioWorklet 不可用时保留现有 ScriptProcessor fallback。
- worklet 初始化在用户点击录音后完成；可在首次授权麦克风时预热，不影响停止后的关键路径。

---

## 6. 源码单一事实源与镜像防漂移

### 6.1 Plan limits

当前 plan limits 同时存在于 Edge TypeScript、共享 JS、`app.js` 内联对象和 SQL 中，容易再次漂移。

调整：

- `src/shared/planLimits.js` 作为浏览器/LAN JS 的唯一常量源，并补全 admin。
- `src/public/app.js` 直接 import `PLAN_LIMITS`，删除内联副本。
  - **import 路径方案（v3 决策）**：`app.js` 写 `import { PLAN_LIMITS } from '../shared/planLimits.js'`（与 `protocol.js` 相同模式）。
  - `src/public/shared/` 目录不需要创建。
  - `hosted-pwa/scripts/build-static.mjs` 的 `cloudFiles` 归一化分支需扩展 `replaceAll` 规则，把 `"../shared/planLimits.js"` 替换为 `"./shared/planLimits.js"`（与现有 `"../shared/protocol.js"` → `"./shared/protocol.js"` 相同）。
- Edge TypeScript 和 SQL 因运行环境不同保留副本，但新增测试解析三端值并断言一致。

### 6.2 Hosted PWA mirror

`hosted-pwa/scripts/build-static.mjs` 的 `verifyMirroredSources()` 增加：

- `cloudRecorder.js`
- `cloudTranscribe.js`
- `wavEncoder.js`
- `i18n/en.js`
- `i18n/zh-CN.js`
- `i18n/i18n.js`

> **注意**：当前需先验证这些文件两侧内容是否一致；若不一致，先手动同步再加入门禁。后续任何一侧修改而未同步，build 必须失败。

**`cloudFiles` 归一化规则扩展**：

当前 `build-static.mjs` 的 `cloudFiles` 循环（第 91-103 行）只对 `"../shared/protocol.js"` 做 `replaceAll`。加入新文件后需同时扩展：

- `"../shared/protocol.js"` → `"./shared/protocol.js"`（现有）
- `"../shared/planLimits.js"` → `"./shared/planLimits.js"`（新增）

`cloudRecorder.js`、`cloudTranscribe.js`、`wavEncoder.js`、`i18n/*.js` 如果没有 `../shared/` import，归一化后应与源文件一致。

---

## 7. UI 行为

- 录音按钮附近显示当前批处理上限：15 秒或 60 秒。
- 不使用 `∞`，不把实际不存在的能力包装成管理员特权。
- 到达上限时自动调用 `stopRecording()`，并显示“已到 15/60 秒上限，正在识别…”。已录制的前 15/60 秒正常上传，不显示错误状态。
- 录音停止后立即进入“正在识别”状态；文本返回后先写入手机文本框，再异步发送桌面。
- Realtime 发送失败时保留手机文本和复制入口，不能因桌面 ack 失败丢失转写结果。
- 录音前 plan 尚未加载时按 free 上限工作，不阻塞麦克风启动。

---

## 8. 统一的 60 秒边界

为避免 provider 分支、套餐和 UI 出现不同语义，系统只维护一个批处理边界：

- free：15 秒。
- pro / admin：60 秒。
- 全局绝对上限：60 秒。
- PWA 录音达到 15/60 秒时自动停止，只生成并上传上限以内的 WAV。
- Edge 的 60 秒校验只是一道安全兜底；正常 PWA 请求不会触发该错误。
- Flash 和 SentenceRecognition 都只接收 60 秒以内的请求。
- 不实现自动分段、连续听写、实时 ASR、WebSocket relay 或浏览器直连腾讯。

未来如果产品确实出现超过 60 秒的真实需求，应单独立项重新评估；本设计不预留隐藏分支，也不提前增加相关协议和状态机。

---

## 9. 明确不做

- 不在本轮加入 2.8 秒空闲缓冲。
- 不让正常录音超过套餐上限；到点自动停止并识别已有内容。
- 不增加自动分段、实时 ASR 或 ASR WebSocket。
- 不为了“功能一致”复制 LAN filler 误删 bug。
- 不编辑已经部署的历史 migration。
- 不增加录音停止后的 plan 查询。
- 不在前台等待 usage 写入。
- 不把服务端 SecretKey 或 service role key 暴露到 PWA。
- 不用客户端传入的 plan、duration 或 metadata 作为权限依据。

语音命令若后续补齐，应在桌面 agent 收到最终文本后立即解析并执行；普通文本仍立即输出，不引入跨录音等待。

---

## 10. 测试与验收

### 10.1 ASR 契约

- Flash 和 Sentence 请求参数四项完全一致。
- 两条 provider path 都经过同一后处理。
- 句首/标点边界 filler 被删除。
- “哼唱”“啧啧称奇”等正常词不被破坏。
- 标点、数字和中英文混合文本保持正常。
- Flash 明确不可用时短音频能 fallback。
- timeout 不产生无上限串行等待。
- 正常 PWA 录音不会生成超过 60 秒的请求；手工构造的超长请求在腾讯调用前被后端兜底拦截。

### 10.2 套餐和安全

- free 在真实 15 秒附近自动停止，随后正常识别前 15 秒，不是 10 秒，也不是报错。
- pro/admin 在真实 60 秒附近自动停止，随后正常识别前 60 秒，不是 55 秒，也不是报错。
- recorder 根据 sample count 停止；timer throttling 不会生成超长音频。
- 后端忽略客户端传入的 plan 和 duration，以 WAV header + DB plan 为准。
- 所有 plan 都执行 `reserve_and_get_plan()`；admin 也有 request 去重和 usage event。
- 升级/降级在 plan cache TTL（当前最多 60 秒）内完成收敛；admin 身份每次 RPC 都由数据库重新确认，缓存不得直接授予 admin。

### 10.3 延迟和稳定性

- 在 Wi-Fi、4G/5G 和首次冷启动条件下分别采样。
- 按 3 秒、8 秒、15 秒、60 秒音频分桶。
- 记录 `encode_ms`、`edge_pre_asr_ms`、`asr_ms`、`response_ms`、`desktop_delivery_ms` 和总时长。
- P95 不达标时先定位具体阶段，不允许通过延长 toast 或动画隐藏。
- Realtime ack 超时不丢失手机文本。
- `prefers-reduced-motion` 不影响录音和状态可见性。

### 10.4 构建防漂移

- `src/public` 与 `hosted-pwa/public` 的录音、转写、WAV、i18n 镜像不一致时 build 失败。
- JS、Edge TS、SQL 三处 plan limit 不一致时测试失败。
- Edge Function 单元测试覆盖 usage 成功、失败、拒绝和 admin 路径。

---

## 11. 可观测性

Edge 响应增加：

- `X-Request-Id`
- `Server-Timing: auth;dur=..., parse;dur=..., reserve;dur=..., asr;dur=..., post;dur=...`
- CORS 暴露 `Server-Timing` 和 `X-Request-Id`
- 如需通过跨域 `PerformanceResourceTiming` 读取阶段数据，按实际 PWA origin 设置 `Timing-Allow-Origin`，不得使用携带凭据的宽泛来源配置

客户端只记录数值和枚举：

```text
request_id
plan
audio_duration_bucket
audio_size_bucket
provider_path
fallback_reason
encode_ms
edge_total_ms
desktop_delivery_ms
stop_to_desktop_ms
success | failure_code
```

禁止记录音频、转写正文、邮箱、用户姓名、窗口标题或完整 access token。

---

## 12. 实施顺序

### Phase 0：先测量（可与 Phase 1 并行启动）

1. 增加客户端时间点和 Edge Server-Timing。
2. 采集当前基线，按音频时长和 provider path 分桶。

> **Phase 0 与 Phase 1 的依赖关系（v3 明示）**：
>
> - Phase 1 的 Task 1-6 **不依赖** Phase 0 测量结果，可以立即并行启动。
> - Phase 1 的 Task 7（provider 总 deadline）**使用 v3 给出的固定数值**（总 12s，Flash 8s），不依赖 Phase 0。后续可据 Phase 0 数据调优。
> - Phase 0 的 `encode_ms` 测量结果只影响**独立的 AudioWorklet 后续任务**，不影响本轮 Phase 1。
> - Phase 0 的 admin `reserve_ms` 测量结果用于验证删除 fast path 后的延迟是否可接受；若 P95 > 350ms，应优化 RPC 查询（如在 `usage_events(user_id, created_at desc, status)` 上建复合索引），但**不回退** fast path 删除决策。

### Phase 1：本轮必须完成

**可并行启动的任务（无相互依赖）：**

1. 对齐 Tencent 参数。
2. LAN/Cloud 一起修正 filler 后处理和契约测试。
3. 删除 admin fast path，所有请求保留一次原子 RPC。
5. 前端接入共享 PLAN_LIMITS，按真实上限停止，更新 i18n/UI（`currentUserPlan` 新增）。
6. 补全 hosted mirror build gate。

**有依赖关系的任务（需前置任务完成后集成）：**

4. 新 migration 更新 15/60/60 batch limits 和毫秒级判断。
   - 依赖：Task 3（删 fast path）和 Task 5（前端 plan）需与此协调。
   - migration 部署后才能集成测试 admin 路径。
7. 增加 provider 总 deadline、fallback 分类和回归测试。
   - 依赖：Task 1（参数对齐）和 Task 2（后处理）完成后，再重构 `transcribeTencentWav` 的 deadline 结构。

### 不在本轮范围

AudioWorklet 增量 PCM：只有当 Phase 0 基线显示 `encode_ms P95 > 120ms` 或 60 秒录音出现明显 UI 卡顿时，才作为独立后续任务立项。不与本轮功能修改捆绑。

---

## 13. 改动文件范围

Phase 1 预计涉及：

| 文件 | 改动 |
|---|---|
| `supabase/functions/_shared/tencent_asr.ts` | 参数、统一后处理、deadline、fallback 分类 |
| `supabase/functions/_shared/tencent_asr.test.js` | 两条 provider path 参数测试 + filler fixture 10 条 |
| `supabase/functions/transcribe/index.ts` | 删除 admin fast path、`max_audio_ms` 读取、waitUntil 统一、Server-Timing、格式校验 |
| `supabase/functions/_shared/plan_limits.ts` | batch limits 15/60/60 |
| `supabase/functions/_shared/wav.ts` | `parsePcmWavDurationMs` 增加格式校验返回（PCM/mono/16-bit/16kHz） |
| `supabase/functions/_shared/cors.ts` | 暴露 `Server-Timing`、`X-Request-Id`；增加 `Access-Control-Expose-Headers` |
| `supabase/functions/_shared/contracts.ts` | 新增 `fallback_reason` 相关常量（如有需要） |
| `supabase/migrations/0015_align_cloud_asr_limits.sql`（新） | 更新 RPC：毫秒级判断、15/60/60 上限、`max_audio_ms` 字段 |
| `src/server/asr/transcriber.js` | 采用相同的保守 filler 行为（替换 `FILLER_RE` 字符类） |
| `src/server/asr/transcriber.test.js`（新） | LAN filler 契约测试（10 条 fixture） |
| `src/shared/planLimits.js` | 补全 admin，free 的 maxAudioSeconds 改为 15 |
| `src/public/app.js` | import PLAN_LIMITS、新增 `currentUserPlan`、动态上限停止、UI 状态 |
| `src/public/cloudRecorder.js` | 接受 `maxDurationMs` 参数，sample-count 停止机制 |
| `src/public/cloudTranscribe.js` | 透传 `request_id` 等可观测性字段到调用方 |
| `src/public/i18n/zh-CN.js` | `reachedLimit` 改函数型；新增 `maxDurationHint` |
| `src/public/i18n/en.js` | 同上 |
| `hosted-pwa/scripts/build-static.mjs` | 扩大 mirror verification + `planLimits.js` 归一化 |
| 对应 `hosted-pwa/public/*` 镜像 | 与源文件保持一致（cloudRecorder/cloudTranscribe/wavEncoder/i18n/*） |
| 新增三端 plan_limits 一致性测试（位置待定） | 解析 JS/TS/SQL 三处 plan limit，断言一致 |

**测试框架说明**：Edge Function 测试用 `node --test`（Node 20+ 原生 TypeScript），参考现有 `tencent_asr.test.js` 的 import 模式。LAN 端测试同样用 `node --test`。

---

## 14. 外部约束依据

- 腾讯 SentenceRecognition：60 秒内、3MB 内：<https://cloud.tencent.com/document/product/1093/35646>
- 腾讯 FlashRecognition 请求参数：<https://cloud.tencent.com/document/product/1093/52097>
- Supabase Edge Function limits：<https://supabase.com/docs/guides/functions/limits>

---

**文档结束。v3 已补全所有技术决策和文件清单，可直接进入 writing-plans 阶段生成详细实施计划。Phase 0 测量可与 Phase 1 并行启动。**
