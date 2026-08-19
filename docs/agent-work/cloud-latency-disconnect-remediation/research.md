# 云模式延迟 + 桌面端断联：架构级诊断

日期：2026-08-19。来源：四路并行审计（手机 PWA 全链路 / 云端后端+DB / 桌面 agent + realtime-js 源码 / 历史修复 git 取证）。

## 一、为什么修了七八版都没根治（历史取证结论）

1. **2026-07-27 ~ 08-03 整整一周在优化一条坏掉的路径**：代码"优先 FlashRecognition"，但在 Supabase Edge Runtime 里 Flash 因 Host/Content-Length 请求头问题一直 404（cd40eff 才修复），所有请求静默回退到慢 5–7s 的 SentenceRecognition。此窗口内全部"延迟修复"（超时调优、token 缓存、RPC 合并）在给错误的路径省 30–150ms。
2. **没有测量闭环**：无分阶段计时、无 provider 实际命中日志（efde013 才加，晚一周）、无端到端计时验证。每次修复只跑单元测试。
3. **断联被当作客户端生命周期 bug，从未当作协议/可靠性设计问题**：四轮补丁（通道缓存、预热、generation 防护、协议版本门控）都是在补偿"没有心跳确认、没有重连恢复、没有消息重投"的根本缺失。
4. **结构性大项一直被推迟**：2026-07-26 设计文档中真正有效的 O7（手机直连腾讯）/O8（AudioWorklet）/O9（流式识别）至今未做。延迟随录音时长线性增长是架构决定的。
5. **修复引入回归再修回归**：087fca7 admin 快速路径被 89b71ce 回滚；0fc014e 2s presence 刷屏被 800699f 改 5s。
6. **镜像分叉陷阱**：`cloudRecorder.js` 在 `src/public`（源）与 `hosted-pwa/public`（部署副本）已实际分叉——部分修复只改源目录，线上未生效。`src/public` 与 `hosted-pwa/public` 必须同步（构建期 verifyMirroredSources 检查的是字节一致性，分叉说明该检查被绕过或当时未跑）。

## 二、延迟：点停止 → 文字上屏的完整串行链

结构性成本（按大小排序）：

| # | 环节 | 证据 | 成本 |
|---|------|------|------|
| 1 | 未压缩 WAV 整段上传（32KB/s；60s=1.9MB，上限 3MB） | cloudTranscribe.js:60，transcribe/index.ts:71-74 只收 WAV | 移动网络 2–10s，**最大单项** |
| 2 | ASR 最坏栈：Flash 8s 超时 → Sentence 回退 ≤4s = 12s；预算从 ASR 调用起算，验签+RPC 时间另算，可撞 Edge 墙钟限制被杀 | tencent_asr.ts:9-13,143-146 | 最坏 12s+ |
| 3 | 冷目标通道订阅：预热失败被静默吞掉，发送时才订阅私有通道（含 DB 鉴权 RTT），超时上限 10s | cloudRealtime.js:161-163,166-181,201-208 | 首次发送最多 10s |
| 4 | 服务端串行链：auth.getClaims RTT → formData → reserve_and_get_plan RPC（内部 5 条 SQL：advisory lock 按用户+月串行化、整月 SUM、1 分钟 COUNT、订阅 SELECT、profile SELECT）→ ASR | transcribe/index.ts:50,194；migrations/0017:90-114 | 数百 ms 起，重用户更糟 |
| 5 | 每请求重建 2 个 supabase 客户端 + esm.sh 远程导入 | transcribe/index.ts:1,36,44 | 冷启动秒级 |
| 6 | 手机 token 缓存仅 50s，口述场景几乎每次过期 → getSession 可能触发网络刷新进关键路径 | cloudTranscribe.js:3 | 0–0.5s |
| 7 | 主线程同步 concat + WAV 编码 | cloudRecorder.js:64-71, wavEncoder.js | 0.1–0.5s（Pro 300s 更糟） |
| 8 | 手机 fetch 无超时无重试 | cloudTranscribe.js:60-67 | 网络抖动 = 卡死数分钟；每次重试用新 requestId 重复扣配额并计入限流（免费档 10 次/分） |

现状最好 ~2s，典型 3–9s，最坏 20s+ 或直接挂死。

## 三、断联：为什么"必须重启"（桌面端，按致命度排序）

realtime-js 源码级结论：socket 断线必重连（无限重试）；channel join error 会无限 rejoin；**但 channel 一旦 `close` 就永久死亡**（channel.js:66-71，无 rejoin），且 errored 状态的 channel 上 `subscribe()` 是 no-op、`supabase.channel(topic)` 会返回缓存中的死对象（RealtimeChannel.js:137-140, RealtimeClient.js:329-341）。

1. **B2 刷新令牌死亡 → 永久离线**：桌面端匿名登录（main.js:90）；令牌过期后刷新失败 → SIGNED_OUT → supabase-js 清空 realtime token → 私有通道 join 永远 403。**全仓库无任何 onAuthStateChange 处理**，无重新登录/重配对路径。
2. **B3 服务端 close 通道 → 永久死亡**：agent 的 subscribe 回调只打日志（realtimeAgent.js:240-247），CLOSED/CHANNEL_ERROR 无任何重建逻辑。
3. **B3b errored 通道对象复用陷阱**：被删通道若残留 realtime.channels，重建的同 topic channel 是死对象，订阅 no-op——ack 通道 await 永不 resolve。
4. **B5 UI 撒谎**：renderer 只要见过 SUBSCRIBED 就显示"已上线"，从不降级（renderer.html:269-294）。叠加 B2/B3 = 永久死亡但显示在线；手机端只能靠过期 presence 猜。
5. **B1 启动死局**：持久化的匿名 session 失效时 getUser 抛错进"初始化失败"，而"解除绑定"按钮只存在于在线面板（renderer.html:221-230），用户无法自救。匿名刷新令牌单次使用、吊销不可恢复。
6. **C1 唤醒无处理**：无 powerMonitor resume/suspend、无 online/offline 监听（main.js 全文）。睡眠唤醒后靠心跳超时 25–50s 才检测到死链，每次唤醒约 1 分钟盲区；跨过令牌过期的睡眠升级为 B2。
7. 次要：authStorage.js 读写无锁，并发写坏 session 文件 → 触发 B1；B4 ack 通道订阅失败在回调里 rethrow（未处理 rejection，粘贴已发生但手机永远收不到 ack）；零持久化日志。

## 四、交叉结论

- 延迟与断联共享同一深层原因：**整段批处理 + 无可靠性契约 + 无测量**。
- 任何只调参数的修复（超时值、缓存 TTL、刷新间隔）已被历史证明无效。
- 唯一被验证过的根因级修复（cd40eff 请求头）带来 9-11s → 3.8s 的改善——证明路径正确时这套栈本身不慢。
