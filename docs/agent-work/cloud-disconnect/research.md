# 云端断联根因调查（2026-09-27）

## 结论

云端反复断联的**最初触发点是网络路径，不是客户端代码**；客户端的重连状态机把每次掉线放大了 3.4 倍，把秒级可恢复的抖动变成分钟级"connecting"风暴。

## 证据链（实测）

### 触发点：CN→Cloudflare 路径间歇性单向黑洞

- 直连 `supabase.co`：100% 被 RST（GFW SNI 阻断）→ `vb-api.heyflint.top` 是唯一路径
- 实测捕获一次完整黑洞（01:14:30→01:17:15，3 分钟）：所有既有连接**入站中断而出站正常**（心跳一直发、回复全丢），连接静默死亡（无 close 帧）。同刻桌面 app 57 秒后因 phoenix heartbeat 超时报 CHANNEL_ERROR
- **黑洞期间新建连接 4 秒内成功**（新 TCP 流走不同回程路径）→ 掉线后立即重连本可秒级恢复
- 握手失败呈阵发性（坏窗口 ~30-50%，好窗口 15 分钟零异常）
- Supabase 服务端 ~66s 空闲超时干净关闭（code=1000，14 样本一致）无流量连接；25s 心跳完全避免，与应用无关
- 系统 HTTP/SOCKS 代理（127.0.0.1:7897）无关：走代理与直连逐字节一致

### 决定性对照：客户端代码零差异，只差路径

`git diff v0.1.1 v0.1.2 -- 云端文件` 为空（唯一变化是 URL 切到 vb-api）：

| | v0.1.1 直连（9/21） | vb-api（9/25-26） |
|---|---|---|
| 中位在线时长 | 932s | 75s |
| 掉线次数/天 | 22 | 209-212 |

9/25 白天风暴时跑的是 v0.1.2（v0.1.3 下午才装）→ 排除近期代码回归。

### 放大器：桌面 purge 回声循环

phoenix `leave()` 会触发通道 `CLOSED` 回调 → purge 旧通道时旧回调又排下一轮 `scheduleReconnect` → 定时器 purges 刚建好的健康通道 → 循环。9/26 日志分类：**209 次真实掉线 vs 499 次自我回声**（70% 调度自己制造），中位恢复周期 100s。

### 手机端

任一核心通道 fatal → 全量 teardown（含健康发送通道）+ UI 显示云不可用。

### 平反项

Worker 透传本身双向正常（join/ack/phx_close 均验证）；supabase-js 心跳在发且有效。

## 修复（同日实施）

原则：**信任 phoenix 自愈**（socket reconnectTimer + errored 通道 connOpen 后自动 rejoin），只保留两件人工干预：

1. 服务端 `phx_close`（CLOSED 状态 phoenix 永不 rejoin）→ removeChannel 重建**该通道**，重建前置空引用使旧回调失活（回声护栏），5s 最小间隔
2. 看门狗：message 通道连续 150s 不健康才全量重建兜底

配套：心跳 25s→15s（桌面 `createAgentClient` + 手机 `auth.js`）；桌面健康判定只看 message 通道；手机 presence 波动不再拆通道/打崩 UI（`app.js` 忽略 `presence:*` 与 `rebuild:*` 状态）。

改动文件：`src/agent/realtimeAgent.js`、`src/agent/electron/renderer.html`、`src/public/cloudRealtime.js`、`src/public/app.js`、`src/public/auth.js` + hosted-pwa/mobile 镜像。LAN 与 ASR 零改动。

## 验证

- 单元测试 405（根目录）+ 11（hosted-pwa）全绿；新测试覆盖：CHANNEL_ERROR 不重建、CLOSED 只重建被关通道、purge 回声不连锁、看门狗兜底
- 上线前建议 30 分钟实测：日志里每个真实掉线应只有一轮恢复（无 `reconnect:scheduled` 回声链），`health:online` 间隔以分钟计
- 实验脚本：`tmp/cloud-probe*.mjs`（gitignored）

## 无法由客户端修复的部分

路径黑洞本身（GFW/国际链路）。若未来要进一步优化：双端点 fallback（直连 supabase.co 探测性回退——阻断是概率性的）、或换边缘供应商。
