# 执行进度

日期：2026-08-19。Phase 0 + Phase 1 已完成，待部署验证。

## 已完成（Phase 0）

1. **镜像分叉根治**：`src/public/cloudRecorder.js`（含采样数自动停止，e540a15）等 5 个文件同步至 `hosted-pwa/public`；`build-static.mjs` 的 `verifyMirroredSources` 从 4 个白名单文件扩展为两树共有的全部 JS 文件（含 `../shared/`→`./shared/`、`./index.html`→`./app.html` 规范化）。今后任何单侧修改都会构建失败。
2. **分阶段计时**：
   - 手机：`[vb-timing] stop→encode+upload-ready / stop→transcribed / send→ack`（app.js）+ `cloudTranscribe` token/server/total（cloudTranscribe.js）。
   - Edge：`Transcribe stage timing` 日志（auth_ms / form_data_ms / reserve_rpc_ms / asr_ms / audio_size / duration）。
   - 桌面：新增 `agentLogger.js`，agent 状态、auth 事件、电源事件写入 `userData/logs/agent-YYYYMMDD.log`（7 天轮转）。
3. **云识别 fetch 加 30s AbortController**（cloudTranscribe.js），超时给出明确中文错误。

## 已完成（Phase 1：断联根治）

1. **auth 生命周期自愈**（main.js）：启动时探测坏 session 并 signOut 重走匿名登录（修 B1 死局）；`onAuthStateChange` 监听 SIGNED_OUT → 自动重新匿名登录 + 重配对（修 B2 永久掉线）；authStorage 原子写（临时文件+rename，修并发写坏 session）。
2. **通道看门狗**（realtimeAgent.js）：message/presence 通道 CLOSED/CHANNEL_ERROR → 退避（1s/2s/5s/10s）removeChannel 后整体重建；ack 通道失败也 purge 死对象（修 errored 通道复用 no-op 陷阱 B3/B3b）；ack 发送失败不再让 rejection 炸掉 broadcast 回调（B4）；新增 `getHealth()`/`forceReconnect()`。
3. **唤醒秒级恢复**（main.js）：powerMonitor resume → 立即 forceReconnect，不再等 25–50s 心跳超时。
4. **UI 真实状态**（renderer.html）：仅 `health:online` 显示已上线；CHANNEL_ERROR/CLOSED/reconnect 即降级"连接中断，正在重连…"；auth 恢复事件有提示（修 B5 UI 撒谎）。

## 验证

- `npm test`：196 项全部通过（含新增"watchdog 通道 close 后自动重建并恢复健康"测试）。
- `hosted-pwa` 构建门通过（镜像零漂移）。
- 全部改动文件 `node --check` 语法通过。

## 待办 / 未验证

- ✅ **已确认并修复（2026-08-19）**：生产 secrets 缺失 `TENCENT_APP_ID`，所有请求走 SentenceRecognition 慢速回退（Edge 日志实锤：provider: "sentence"，无一例 flash）。已通过 Supabase 面板添加 `TENCENT_APP_ID=1342760049`（取自本地 .env），即时生效，无需重新部署。下次识别起应走 Flash（日志应显示 provider: "flash"）。
- **需要部署**：Edge Function（transcribe）与 PWA（Cloudflare Pages）需部署后打点才可见。
- **桌面端手动矩阵**（需真机）：睡眠 5 分钟唤醒 / Wi-Fi↔热点切换 / 断网 5 分钟恢复 / 服务端 close 通道 → 全部应在 10s 内自愈，`logs/agent-*.log` 可证。
- Phase 2（音频压缩、服务端并行化、DB 锁消除）与 Phase 3（流式 ASR）未开始，见 plan.md。
