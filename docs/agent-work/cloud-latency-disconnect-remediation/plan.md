# 修复方案：分四个阶段，先测量、再治本

依据：[research.md](./research.md)。原则：每阶段独立可验证、可回滚；不再调超时参数治病。

## Phase 0 — 测量与止血（先做，半天～1天）

目标：以后任何延迟/断联问题都能在日志里直接看到病灶，而不是靠用户报障。

1. **端到端分阶段计时**：
   - 手机：`stopRecording` 起打点（encode_done / token_ready / uploaded / server_done / send_acked），console + 可选上报。
   - Edge transcribe：每次请求记录 provider 实际命中（flash/sentence/fallback_reason）+ 各阶段 ms（已有部分，补齐 auth/formData/RPC 三段）。
   - 桌面：onStatus 全量写入 `userData/logs/agent-YYYYMMDD.log`（轮转，含 socket close/error、channel 状态、auth 事件）。
2. **同步镜像分叉**：把 `src/public/cloudRecorder.js` 与 `hosted-pwa/public` 对齐，查明 verifyMirroredSources 为何没拦住。
3. **手机 fetch 加 30s AbortController + 一次重试**（重试沿用同一 requestId 需服务端配合，先只做超时）。
4. **验证生产 secrets**：`supabase secrets list` 确认 `TENCENT_APP_ID` 存在；抽查 Edge 日志确认 Flash 实际命中率。

验收：真实手机+桌面跑 10 次口述，日志能完整重建每次的时间线；知道每一毫秒花在哪。

## Phase 1 — 桌面端稳定性（断联根治，1～2天）

目标：任何断线场景（睡眠唤醒、网络切换、令牌死亡、服务端 close）在 10 秒内自愈，UI 状态真实。

1. **Auth 生命周期**：
   - 监听 `onAuthStateChange`：SIGNED_OUT / 会话失效 → 若是匿名身份则自动重新匿名登录并走重配对，不让用户看到死局。
   - 启动时 `getUser` 失败 → 清掉坏 session 重走匿名登录（修 B1），"解除绑定"入口在初始化失败态也可达。
   - authStorage 写入改为原子写（临时文件+rename）。
2. **通道看门狗**（修 B3/B3b）：
   - message/presence/ack 通道订阅回调里对 CLOSED/CHANNEL_ERROR → `supabase.removeChannel(死对象)` 后重建新 channel 订阅（退避 1s/2s/5s，无限重试）。
   - 绝不 await `channel.subscribe()` 的返回值（它返回 this，await 是无效的）；用现有 subscribeRealtimeChannel 包装。
3. **电源/网络事件**：`powerMonitor.on('resume'|'suspend')` + `online/offline` → resume 时主动断开 socket 立即重连（把 25–50s 心跳盲区压到秒级），并在 socket 重连 SUBSCRIBED 后强制 `trackPresence(true)`。
4. **UI 真实状态**（修 B5）：online 仅在 message+presence 双通道当前均 SUBSCRIBED 时显示；任一通道异常立即显示"重连中"。
5. **ack 路径加固**（修 B4）：订阅失败不 rethrow，降级为本地日志 + 跳过本次 ack。

验收：手动测试矩阵——睡眠 5 分钟唤醒 / Wi-Fi↔手机热点切换 / 断网 5 分钟恢复 / 拔掉网络跨令牌过期 / 服务端主动 close 通道——全部自动恢复，UI 状态全程真实，日志可证明。

## Phase 2 — 延迟削减（不动 ASR 架构，1～2天）

按收益排序：

1. **上传体积**：16kHz 单声道改用有损压缩（Opus/WebM 或 AAC/M4A——腾讯 Flash 支持 wav/mp3/m4a/aac 等；手机端用 MediaRecorder 或 WASP 编码器）。目标 60s 录音从 1.9MB → <200KB，上传时间降 ~90%。服务端 transcribe 同步放宽格式校验。
2. **服务端链路**：
   - supabase 客户端提升为模块级全局（auth header 每请求注入）。
   - `getClaims` 与 `formData` 解析并行；plan RPC 与音频读取尽量并行。
   - `reserve_and_get_plan` 去掉整月 SUM：改为递增计数器行（user+month 单行 UPDATE ... RETURNING），消灭 advisory lock 串行与聚合扫描。
   - Flash 超时 8s → 3s（健康 Flash <1s；超时即说明该回退），避免 8s+4s 叠栈；总预算含验签/RPC 全程计时。
3. **手机端**：
   - token 缓存按 JWT 实际 exp 减 60s，而非固定 50s。
   - 目标通道预热失败不静默：记录并重试；发送时若通道不在已订阅集合，先走 REST broadcast 兜底（realtime 支持 REST fallback）不等订阅。
   - ack 语义修正：超时提示改为"桌面端未确认（可能已粘贴）"，不再断言失败。

验收：Phase 0 的打点显示 p50 停止→上屏 < 1.5s、p95 < 3s（正常网络）。

## Phase 3 — 结构性升级（大项，单独立项）

- 流式识别：录音边录边传（腾讯实时 ASR WebSocket 或分片），停止即出字（<500ms）。可与 docs/agent-work/asr-reuse-optimization 的调研合并推进。
- AudioWorklet 替换 ScriptProcessor（修 iOS 后台截断 + 主线程阻塞）。
- 桌面端自动更新通道（release-readiness 文档已指出缺失：已发布版本无法推送修复，导致旧版本问题在线上长期存活）。

## 风险与回滚

- Phase 1 全部为客户端逻辑 + 可单测；Phase 2.2 涉及新迁移（0018），旧 RPC 保留一个版本以便回滚。
- Phase 2.1 改音频格式需与腾讯 Flash 参数联调，feature flag 控制（`VB_AUDIO_CODEC`），失败自动回退 WAV。
- 每阶段完成后在 docs/agent-work/.../progress.md 记录验证数据。
