# 云端 ASR 对齐与录音时长分级限制 设计文档

## 问题

VoiceBridge 的云端模式（Cloud Mode）与 LAN 模式在 ASR 后处理上存在功能断层，同时录音时长缺少按账号等级（plan）的分级限制。

### 断层一：语气词未清理

LAN 版有两层语气词过滤：

1. **腾讯 ASR 参数层**：`tencentCloudTranscriber.js:129-133` 显式传 `FilterModal=1`（部分过滤语气词）
2. **本地二次清理**：`transcriber.js:8-21` 的 `removeFillerWords()` 用正则删除 9 个独立单字语气词（嗯呃唔噢欸诶哼嘖啧）

云端版两层都没有：

- `tencent_asr.ts` Flash 路径硬编码 `filter_modal=0`（不过滤）
- SentenceRecognition 兜底分支完全不传过滤参数（走腾讯默认值）
- Edge Function 主流程无任何后处理，腾讯返回什么就给什么

**结果**：云端识别结果包含大量"嗯""呃""噢"等语气词，用户体感差。

### 断层二：ASR 参数不一致

LAN 版显式传 4 个过滤参数（FilterDirty/FilterModal/FilterPunc/ConvertNumMode），云端版 Flash 路径只传部分、兜底路径全不传，导致两条路径行为不可控且与 LAN 不一致。

### 问题三：录音时长无分级限制

前端 `app.js:1501-1510` 写死 `55_000ms`，所有用户一律 55 秒，与 plan 完全解耦。后端 `PLAN_LIMITS` 已定义 `maxAudioSeconds`（free=60/pro=60/admin=3600），但前端未使用。admin 用户也被卡在 55 秒。

## 目标

1. **云端 ASR 处理对齐 LAN 版**：语气词清理 + ASR 参数一致
2. **按 plan 分级录音时长限制**：free=15s / pro=60s / admin=600s（UI 显示 ∞）
3. **零延迟影响**：所有处理不增加单次录音往返耗时

## 非目标（本次不做）

- **断句缓冲（asrTextOutputBuffer）**：多段录音合并、句末标点立即 flush、2.8s 空闲 flush 等逻辑不移植到云端。云端每次录音独立处理。
- **语音命令（句号/逗号/换行/发送/删除/清空）**：云端暂不支持。
- **LAN 模式改动**：LAN 版已有的逻辑不动，本次只改云端侧。

理由：用户反馈的"断句不合理"问题主要根源是语气词未清理 + ASR 参数不对齐。解决这两点后断句质量大幅改善。断句缓冲和语音命令是更次级的需求，可后续迭代。

## 方案

### 架构选择：后端处理（Edge Function）

`removeFillerWords` 放在 Edge Function（Deno/TS），不放前端。理由：

- 与 LAN 版架构对称（LAN 是 `transcriber.js` 后端处理，Cloud 也是后端处理）
- 逻辑单点维护，不可绕过
- 延迟影响 <1ms（纯正则替换），可忽略
- PWA 端零改动

### 改动清单

共 7 处改动，分 3 组。

---

## 第一组：云端 ASR 处理对齐

### 改动 1：`removeFillerWords` 移植到 Edge Function

**文件**：`supabase/functions/_shared/tencent_asr.ts`

在文件中新增函数，完全复用 LAN 版 `transcriber.js:8-21` 的逻辑：

```ts
const FILLER_CHARS = "嗯呃唔噢欸诶哼嘖啧";
const FILLER_RE = new RegExp(`[${FILLER_CHARS}]`, "g");

export function removeFillerWords(text: string): string {
  if (!text) return text;
  return text.replace(FILLER_RE, "").trim() || "";
}
```

**文件**：`supabase/functions/transcribe/index.ts`

在主流程（行 121-146）中，拿到腾讯返回的 `text` 后、返回响应前，调用 `removeFillerWords`：

```ts
const rawText = await transcribeTencentWav({...});
const text = removeFillerWords(rawText);
return jsonResponse({ ok: true, request_id: requestId, text });
```

### 改动 2：ASR 参数对齐

**文件**：`supabase/functions/_shared/tencent_asr.ts`

**Flash 路径**（约行 95-107）：

```diff
- filter_modal: "0",
+ filter_modal: "1",
```

其余 Flash 参数（`filter_dirty: "0"`, `filter_punc: "0"`, `convert_num_mode: "1"`）已与 LAN 一致，不动。

**SentenceRecognition 兜底分支**（约行 125-149）：

当前 payload 完全不传过滤参数。补全 4 个参数，与 LAN 版 `tencentCloudTranscriber.js:129-133` 一致：

```ts
const payload = {
  ProjectId: 0,
  SubServiceType: 2,
  EngSerViceType: config.engServiceType,
  SourceType: 1,
  VoiceFormat: "wav",
  UsrAudioKey: `voicebridge-${requestId}`,
  Data: audioBase64,
  DataLen: audioLength,
  FilterDirty: 0,        // 新增
  FilterModal: 1,        // 新增（与 LAN 一致）
  FilterPunc: 0,         // 新增
  ConvertNumMode: 1,     // 新增
};
```

---

## 第二组：按 plan 分级录音时长限制

### 改动 3：后端 PLAN_LIMITS 调整

目标配额：

| Plan | monthlySeconds | maxAudioSeconds | rateLimitPerMinute |
|---|---|---|---|
| free | 600（不变） | **15**（原 60） | 10（不变） |
| pro | 18000（不变） | 60（不变） | 30（不变） |
| admin | 1_000_000（不变） | **600**（原 3600） | 10_000（不变） |

需同步修改 **4 处**定义：

| 文件 | 改动 |
|---|---|
| `supabase/functions/_shared/plan_limits.ts` | free.maxAudioSeconds: 60→15；admin.maxAudioSeconds: 3600→600 |
| `supabase/migrations/0011_admin_plan.sql` | free 的 max_audio_seconds: 60→15；admin 的 max_audio_seconds: 3600→600 |
| `src/public/app.js` 行 496-500 | 同上 |
| `src/shared/planLimits.js` | 同上 **+ 补全缺失的 admin 条目**（当前缺失，是 bug） |

`src/shared/planLimits.js` 补全后：

```js
export const PLAN_LIMITS = Object.freeze({
  free:  { monthlySeconds: 600,      maxAudioSeconds: 15,  rateLimitPerMinute: 10    },
  pro:   { monthlySeconds: 18000,    maxAudioSeconds: 60,  rateLimitPerMinute: 30    },
  admin: { monthlySeconds: 1_000_000, maxAudioSeconds: 600, rateLimitPerMinute: 10_000 }
});
```

### 改动 4：前端动态录音计时器

**文件**：`src/public/app.js`

**4a. 新增模块级 plan 状态变量**

在录音状态变量区域（约行 1428-1437）附近新增：

```js
let currentUserPlan = "free";
```

在 `handleAuthState`（行 307-322）的 plan 计算完成后赋值：

```js
const plan = sub?.plan === "admin" ? "admin"
  : (sub?.plan === "pro" && isPaidStatus(sub.status) ? "pro" : "free");
currentUserPlan = plan; // 新增：同步到模块级变量
```

**4b. `beginRecordingState()` 动态计时**

将行 1501-1510 的硬编码 `55_000` 替换为按 plan 动态计算：

```js
function beginRecordingState() {
  // ... 现有的 UI 计时启动逻辑 ...

  const limits = PLAN_LIMITS[currentUserPlan] || PLAN_LIMITS.free;
  const maxSec = limits.maxAudioSeconds;

  if (maxSec >= 600) {
    // admin 或更高：不设自动停止，用户手动控制
    // maxRecordTimer 保持 null
  } else {
    // free(15s) / pro(60s)：预留 5 秒上传/编码余量
    const maxMs = (maxSec - 5) * 1000;
    maxRecordTimer = setTimeout(() => {
      if (isRecording) {
        void stopRecording().catch((error) => {
          console.error("[record] auto-stop failed:", error);
        });
        showToast(t('record.reachedLimit', maxSec));
      }
    }, maxMs);
  }
}
```

注意：free 实际计时 10 秒（15-5），pro 实际计时 55 秒（60-5）。预留 5 秒余量确保音频上传不超时。这个余量策略与当前 55 秒（原 60-5）一致。

### 改动 5：i18n 文案动态化

**文件**：`src/public/i18n/zh-CN.js` 行 102

```diff
- reachedLimit: '已到 55 秒上限，正在上传音频...',
+ reachedLimit: (sec) => `已到 ${sec} 秒上限，正在上传音频...`,
```

**文件**：`src/public/i18n/en.js` 行 102

```diff
- reachedLimit: 'Reached the 55-second limit, uploading audio…',
+ reachedLimit: (sec) => `Reached the ${sec}-second limit, uploading audio…`,
```

**文件**：`src/public/app.js` 调用处（约行 1508）

```diff
- showToast(t('record.reachedLimit'));
+ showToast(t('record.reachedLimit', maxSec));
```

需确认 `t()` 函数支持参数化文案。如果不支持，改为直接拼接：

```js
const msg = currentUserLang === 'zh-CN'
  ? `已到 ${maxSec} 秒上限，正在上传音频...`
  : `Reached the ${maxSec}-second limit, uploading audio…`;
showToast(msg);
```

### 改动 6：Edge Function 音频字节上限按 plan 动态

**文件**：`supabase/functions/transcribe/index.ts` 行 10

当前 `MAX_AUDIO_BYTES = 3 * 1024 * 1024`（3MB）。按 plan 动态调整：

| Plan | maxAudioSeconds | 音频大小估算（16kHz/16bit mono ≈ 32kB/s） | MAX_AUDIO_BYTES |
|---|---|---|---|
| free | 15s | ~480KB | 3MB（不变，留余量） |
| pro | 60s | ~1.9MB | 3MB（不变） |
| admin | 600s | ~19MB | **25MB** |

在 Edge Function 中，从 `reserve_and_get_plan()` 返回的 plan 信息读取用户等级，动态选择字节上限：

```ts
const PLAN_AUDIO_BYTES: Record<string, number> = {
  free:  3 * 1024 * 1024,
  pro:   3 * 1024 * 1024,
  admin: 25 * 1024 * 1024,
};
const maxBytes = PLAN_AUDIO_BYTES[plan] ?? PLAN_AUDIO_BYTES.free;
if (audioLength > maxBytes) {
  return jsonResponse({ error: "audio_too_large" }, 413);
}
```

---

## 第三组：UI 提示

### 改动 7：录音时长上限可视化

让用户在录音前就知道自己的时长上限，营造"free 不够用 → 升级 pro"的转化动力。

**位置**：录音按钮附近的 UI 区域（具体位置在实现时确定，建议在录音按钮下方或计时器旁边）。

**显示规则**：

| Plan | 显示文案 |
|---|---|
| free | `最长 15 秒` |
| pro | `最长 60 秒` |
| admin | `∞` |

**i18n key**（新增）：

```js
// zh-CN.js
record.maxDurationHint: (sec) => sec >= 600 ? '∞' : `最长 ${sec} 秒`,
// en.js
record.maxDurationHint: (sec) => sec >= 600 ? '∞' : `Max ${sec}s`,
```

**admin 显示 ∞ 的理由**：虽然 admin 实际有 600 秒上限（防止滥用），但 10 分钟对人类连续语音输入来说等于"实际上不限制"。显示 ∞ 让 admin 用户感受到特权感，不显示具体数字避免造成"我只有 10 分钟"的心理压力。

---

## 数据流

### 改动后的云端 ASR 链路

```
PWA 录音（按 plan 限制时长）
    ↓
上传到 Edge Function
    ↓
reserve_and_get_plan() 校验 plan + duration
    ↓
MAX_AUDIO_BYTES 按 plan 校验
    ↓
tencent_asr.ts 调用腾讯 ASR
  ├─ Flash 路径：filter_modal=1（与 LAN 一致）
  └─ SentenceRecognition 兜底：FilterModal=1 + 3 个参数补全
    ↓
removeFillerWords(text) 二次清理语气词  ← 新增
    ↓
返回 text 到 PWA
    ↓
PWA 显示 + 发送桌面
```

### 录音时长控制流

```
用户点击录音按钮
    ↓
beginRecordingState()
    ↓
读取 currentUserPlan → PLAN_LIMITS[plan].maxAudioSeconds
    ↓
maxSec >= 600?
  ├─ 是（admin）：不设自动停止，UI 显示 ∞
  └─ 否（free/pro）：设 (maxSec-5)s 定时器，到时自动 stopRecording()
    ↓
录音中 UI 显示倒计时（可选，实现时确定）
    ↓
用户手动停止 或 定时器触发
    ↓
上传音频
```

---

## 测试要点

### ASR 对齐测试

1. **语气词清理**：录制含"嗯""呃"的音频，验证云端返回文本中无独立单字语气词
2. **ASR 参数**：通过腾讯云控制台或日志确认 Flash 路径 `filter_modal=1`、兜底路径 4 参数齐全
3. **标点保留**：验证标点（。！？，）正常保留，不被误删
4. **正常用字不误删**：验证含"嗯"的多字词（如"嗯嗯"作为应答词）的行为——注意：当前正则是全局替换所有匹配字符，"嗯嗯"会被全部删除。这是 LAN 版已有行为，云端对齐即可，不在本次修复范围。

### 录音时长测试

5. **free 用户**：录音到 10 秒（15-5 余量）自动停止，提示"已到 15 秒上限"
6. **pro 用户**：录音到 55 秒（60-5 余量）自动停止，提示"已到 60 秒上限"
7. **admin 用户**：录音不会自动停止，UI 显示 ∞，用户手动控制
8. **plan 切换**：升级/降级后刷新页面，录音时长限制立即生效

### UI 测试

9. **三个等级的 UI 显示**正确（15 秒 / 60 秒 / ∞）
10. **i18n**：中英文文案均正确显示

---

## 风险与注意事项

1. **`removeFillerWords` 误删多字词中的语气字**：如"嗯嗯"（应答）、"啊"（多字词的一部分）。当前正则 `[嗯呃唔噢欸诶哼嘖啧]` 是全局替换所有匹配，不区分独立字还是多字词中的字。这是 LAN 版已有行为（LAN 版注释明确"只删独立单字语气词"但实现上是全局替换），云端对齐即可。如需改进（如只删前后独立的语气字），是独立需求，不在本次范围。

2. **`src/shared/planLimits.js` 补全 admin 是 bug fix**：当前该文件缺失 admin 条目，`getPlanLimit("admin")` 会回落到 free。补全是顺带修复，无副作用。

3. **admin 600 秒的音频文件 19MB**：上传时间可能较长（取决于网络）。25MB 的 `MAX_AUDIO_BYTES` 上限留有余量。如实际遇到网络超时，可考虑流式上传或分片，但不在本次范围。

4. **i18n `t()` 函数的参数化支持**：需在实现时确认 `t()` 是否支持 `(key, ...args)` 形式。如不支持，改动 5 改为直接拼接字符串。

5. **前端 `currentUserPlan` 的初始值**：用户刚进页面、`handleAuthState` 尚未完成时，`currentUserPlan` 默认为 `"free"`。如果用户立即点击录音，会按 free 限制。这是安全侧的保守默认（宁可多限制不允许多录音），可接受。

---

## 改动文件清单

| # | 文件 | 改动类型 |
|---|---|---|
| 1 | `supabase/functions/_shared/tencent_asr.ts` | 新增 removeFillerWords + ASR 参数对齐 |
| 2 | `supabase/functions/transcribe/index.ts` | 调用 removeFillerWords + 动态 MAX_AUDIO_BYTES |
| 3 | `supabase/functions/_shared/plan_limits.ts` | free.maxAudioSeconds: 60→15, admin.maxAudioSeconds: 3600→600 |
| 4 | `supabase/migrations/0011_admin_plan.sql` | 同上（SQL 副本） |
| 5 | `src/shared/planLimits.js` | 同上 + 补全 admin 条目（bug fix） |
| 6 | `src/public/app.js` | 动态录音计时器 + currentUserPlan + PLAN_LIMITS 更新 + UI 提示 |
| 7 | `src/public/i18n/zh-CN.js` | reachedLimit 动态化 + maxDurationHint 新增 |
| 8 | `src/public/i18n/en.js` | 同上 |

共 8 个文件，预计净新增约 60 行，修改约 30 行。
