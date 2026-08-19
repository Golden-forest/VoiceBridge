# Phase 2 交接文档：手机直连腾讯 + 同 Wi-Fi 自动 LAN 模式

日期：2026-08-19。本文档是 /clear 后继续工作的唯一入口，配合 `research.md` / `plan.md` / `progress.md` 阅读。
执行方式：用户将用 superpowers:subagent-driven-development 执行，按本文档的工作包领取任务。

## 一、背景速览（已定案的事实，勿重新调查）

- **架构现状**：手机 PWA（Cloudflare Pages）→ 上传 WAV 到 Supabase Edge（**新加坡**，ref=gqxxknusznbunkiznnal）→ 新加坡调腾讯 ASR（广州）→ 结果回新加坡 → Supabase Realtime 广播到桌面 Electron。音频绕地球一圈。
- **已完成的修复**（commit `bc7a2b8` + 之后的 JWT/客户端复用改动，部分已部署）：
  - 断联根治：通道看门狗、auth 自愈、powerMonitor 唤醒重连、UI 真实状态、桌面日志（详见 progress.md）
  - 延迟：三端计时打点、Flash 熔断器（腾讯国际节点 404 /asr/flash，新加坡 Edge 永远调不通 Flash，已熔断 10 分钟跳过）、JWT 本地验签（SUPABASE_JWKS，失败回退 getClaims）、serviceClient 模块级复用、手机 fetch 30s 超时
  - 生产 secrets 已补 TENCENT_APP_ID（值在本地 .env）
  - 镜像校验已扩展到全部共有 JS 文件（src/public ↔ hosted-pwa/public，`./index.html`→`./app.html`、`../shared/`→`./shared/` 规范化）
- **当前实测延迟构成**（08:31 的计时日志）：手机上传 319KB/10s 音频（跨国线路 1-3s）+ 验签 296-424ms（已改本地验签，待复测）+ 配额 RPC 663-765ms（**数据库本身 <0.2ms，全是网关链路开销**，客户端复用后待复测）+ Sentence 识别 ~1.5s。用户体感"第一下慢、后面快"= 冷启动 + 熔断器 + 各级缓存生效，属实。
- **测试**：`npm test` 196 项全绿。部署 Edge：`SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy <fn> --project-ref gqxxknusznbunkiznnal`（token 需用户重新提供或从 Supabase 面板生成，勿写入仓库）。
- **用户已明确批准**：执行 O7 手机直连 + 同 Wi-Fi 自动 LAN。目标是"停止→出字"进 1 秒内（LAN 路径接近即时）。

## 二、工作包 A：O7 手机直连腾讯（绕过新加坡）

### 原理
音频不再上传到 Edge。Edge 只负责：验证用户身份 → 检查配额 → **签发一次性的腾讯 ASR 签名参数**（HMAC-SHA1，见 `supabase/functions/_shared/tencent_asr.ts` 的 `createTencentFlashRecognitionRequest`——签名只覆盖 method/host/path/query，不含 body，所以可以由 Edge 预签、手机后发）。手机拿到签名后从国内网络直连腾讯，识别完把结果经 Realtime 发桌面。

### 关键设计点（务必遵守）
1. **密钥绝不下发**：手机只拿到一次性签名 + 过期时间戳（timestamp 参数，腾讯按 timestamp 校验签名新鲜度，签名有效期有限）。Edge 侧需在配额预留成功后才签发。
2. **新的 Edge Function**（如 `issue-asr-request`）：JWT 本地验签（复用 `_shared/local_jwt.ts`）→ 调 `reserve_and_get_plan` 预留配额（返回 request_id）→ 返回 `{ signed_url, headers, request_id }`。请求体很小（<1KB），一次快速往返。
3. **手机端改造**（`src/public/cloudTranscribe.js` 或新模块）：
   - 先调 `issue-asr-request` 拿签名（这一步仍过新加坡，但 <1KB，往返 ~300-500ms）
   - 直接 `fetch(signed_url, {method:"POST", headers, body: wavBlob})`——国内直连腾讯 Flash 端点（`asr.cloud.tencent.com`，国内 DNS 解析正常，已本地验证 854ms 识别成功）
   - 成功后回报结果（新 Edge Function `report-asr-result` 或并入现有：更新 usage_events 状态 + 返回文本；失败/超时回退现有 Edge 全代播路径）
4. **注意**：直连用的是 Sentence 还是 Flash？手机直连国内节点 Flash 可用（本地已验证）。engine_type 等参数由 Edge 签名时固定。
5. **降级链**：直连失败（网络/签名过期）→ 回退现有 Edge 代播 → 都失败才报错。配额已在签发时预留，注意失败路径要释放（update usage_events status='failed'）。
6. **计费安全**：签名参数包含 timestamp，Edge 端记录 request_id↔签名映射可不必要，但 usage_events 必须闭环（reserved→success/failed）。防止刷签名：rate limit 已有（每分钟次数）。
7. **镜像同步**：所有 src/public 改动必须同步 hosted-pwa/public（构建门会强制报错，按报错提示同步即可，注意 import 路径规范化规则）。

### 验收
- 真机：停止→手机收到文本 < 1.5s（正常国内网络）；Edge 日志可见 issue/report 两段耗时
- 断网/签名过期场景正确回退且配额不泄漏
- `npm test` 全绿 + 新增单测（签发、回退、配额闭环）

## 三、工作包 B：同 Wi-Fi 自动 LAN 模式

### 原理
用户手机和电脑常在同一 Wi-Fi。此时手机直连 Mac 上的本地服务器（`src/server`，LAN 模式代码完整保留，历史上最快：说完即达）。

### 关键设计点
1. **桌面端上报 LAN 地址**：Electron agent 已在 presence.track 里上报 windows 等元数据（`src/agent/realtimeAgent.js` trackPresence）。增加 `lanEndpoints`：本机所有内网 IP + 端口（复用 `src/server/network/getLocalIp.js`）。注意：本地 server 必须在跑——当前 cloud 模式下 Electron 没起本地 HTTP/WS 服务，需要把 `src/server` 的 LAN 服务（upload + ws）在 Electron 里作为可选组件启动（端口可沿用原 LAN 模式默认端口，写进 presence）。
2. **手机端判定**：拿到 lanEndpoints 后并发探测（fetch `http://<ip>:<port>/health`，超时 500ms×N）。可达 → 本地 token 校验后走 LAN 路径（上传+识别+发送全部局域网内完成）；不可达 → 云路径。判定结果缓存，网络变化时重探。
3. **鉴权**：LAN 通道不能裸奔。方案：手机把云配对时获得的凭据派生 token 发给本地 server 验证（最简：桌面 agent 通过 presence 下发一次性 challenge，手机回 HMAC；或复用现有 LAN 模式的配对码机制，见 src/server 现有实现——先读代码再定，别发明新轮子）。
4. **识别也在本地做？** LAN 模式原本由本地 server 直连腾讯（国内网络，快）。保持原状即可，ASR 凭证从哪来是重点：本地 server 需要腾讯密钥——**不能硬编码进安装包**。方案：本地 server 向 Edge 请求"为本次会话签发的短期凭证"或逐次签名（可复用工作包 A 的签发接口，本地 server 代手机直连腾讯）。首选逐次签名，密钥永不出 Edge。
5. **模式切换的用户感知**：自动切换要在 UI 上标明当前通道（"局域网直连 / 云端"），切换失败静默回云。
6. **不破坏云模式**：LAN 不可用时一切照旧。所有 LAN 判定失败都不应弹错误。

### 验收
- 真机同一 Wi-Fi：停止→电脑出字接近即时（<800ms）；关掉桌面端 LAN 服务 → 自动回云端无感
- 跨网段/防火墙拦截 → 探测失败回云，不卡 UI
- `npm test` 全绿 + 新增单测（探测、回退、鉴权握手）

## 四、执行顺序与协作

1. 工作包 A 先行（B 的"逐次签名"依赖 A 的签发接口）。
2. 每个工作包：先读现有代码（cloudTranscribe.js / cloudRealtime.js / src/server/** / realtimeAgent.js / device-pairing）再动手；TDD；改动后 `npm test` + `cd hosted-pwa && node scripts/build-static.mjs` 必须通过。
3. 部署验证需用户提供 SUPABASE_ACCESS_TOKEN（或用户在浏览器面板操作）；桌面端改动需用户重新打包安装才能真机验证。
4. 所有进度记录到 progress.md。

## 五、遗留小项（顺手做，不单独立项）

- `docs/agent-work/cloud-latency-disconnect-remediation/progress.md` 更新 JWT/客户端复用部署状态
- 语音上传体积压缩（Opus/M4A）在工作包 A 完成后评估——若直连后上传瓶颈消失，优先级降低
- 提醒用户：对话中泄露过 Supabase access token，调试结束后到 Account → Access Tokens 撤销 `claude-deploy-20260819`
