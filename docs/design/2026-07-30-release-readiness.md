# VoiceBridge 发布前工作清单

> **作者**：lin
> **日期**：2026-07-30
> **状态**：进行中
> **关联历史**：项目接近尾声，需要接入支付、上架各大应用商店。本文档梳理从"功能开发完成"到"可公开发布"之间的全部必要工作。

## 2026-09-25 自用版上线结论

已完成并部署当前自用版的阻塞项：手机账号与匿名桌面运行身份安全绑定、云端/局域网共用管理员权益、60 秒签发链路、直录 16 kHz WAV、网络地址变化后局域网证书重建、设备所有权列保护、Realtime topic 隔离、遗留 `processing` 请求清理，以及直接生产依赖漏洞清零。生产 PWA、三个关键 Edge Functions、数据库迁移和本机桌面 App 均已替换并验证。

2026-09-25 补充：桌面端已升级到 0.1.3，在线状态仍会展示手机二维码和固定网址；手机端 Realtime 在首次订阅失败、断网恢复和回到前台时会自动重建连接，并会恢复上次使用的在线电脑。手机网页依赖已全部本地打包，不再运行时加载第三方 CDN。已生成 Capacitor iOS/Android 原生工程，Android debug APK 和 iOS 模拟器构建通过；真机 iOS 签名、真机麦克风及自签名局域网证书仍需设备验收。

以下事项明确延后，不阻塞当前单人自用：

- [ ] macOS/Windows 正式签名、公证与安装器；当前 macOS 包仍是 ad-hoc 签名。
- [ ] 桌面端自动更新；当前升级仍需手工替换 App。
- [ ] 付费订阅全流程、退款/取消和删号时的计费侧清理；开始收费前必须完成。
- [ ] 崩溃上报、服务端告警与长期可观测性。
- [ ] Windows、Intel Mac 与移动商店构建验证。
- [ ] 在真实手机上持续做麦克风、局域网切换、网络切换和 60 秒长录音回归；自动测试不能完全覆盖设备权限与路由器差异。

---

## 0. 本地版 vs 云端版：不冲突

| 维度 | Local Mode | Cloud Mode |
|------|-----------|------------|
| 入口 | Electron 内置局域网服务（express HTTPS） | Electron 桌面 App + Supabase Realtime |
| 通讯 | 局域网 WebSocket | Supabase Realtime 跨网 |
| ASR | 本地 `.env` 直调腾讯云 | Supabase Edge Function `/transcribe` |
| 鉴权 | 配对码 + 已登录账号权益（仅 pro/admin） | Supabase auth + 套餐配额 + Stripe |

两种传输模式共用同一登录账号和权益判定。Electron 桌面端默认保持云端在线；只有 `pro` / `admin` 才会启动局域网服务，`free` 不会启动，也不能通过配对码绕过会员限制。管理员单次录音上限为 60 秒。

---

## 1. P0：上架前必须解决（安全 / 合规）

### 1.1 ✅ 代码保护与敏感信息（已完成 2026-07-30）

**问题**：
- asar 未启用，源码以明文直接发布
- `node_modules/.cache/wrangler/` 打包进了 app，泄露 Cloudflare 账户 ID（`b674efb0e3f344e3fcadb45e737497a7`）和注册邮箱（`2664375181@qq.com`）
- `src/server/`（含 TencentCloud ASR 调用逻辑）被冗余打包，运行时不使用但逆向可见
- `README.md` 等文档被冗余打包

**已采取措施**：
- 在 `package.json` 的 `forge.packagerConfig` 中：
  - 启用 `"asar": true`
  - 新增 `ignore` 规则排除 `.wrangler/`、`node_modules/.cache/`、`node_modules/.bin/`、`src/server/`、`README.md`、`tmp/`、所有 `.md` 文件
- 清理源头 `node_modules/.cache/wrangler/` 和项目根 `.wrangler/`
- 清理旧产物 `out/`，重新打包验证

**残留风险（P2 处理）**：
- asar 只是归档，不是加密，`npx asar extract` 一行命令就能解开
- 建议后续上 bytenode（V8 字节码）对 `main.js` / `realtimeAgent.js` 进一步保护

### 1.2 ⏳ 代码签名 + 公证（macOS / Windows）

**问题**：未签名、未公证，用户首次运行会被 Gatekeeper / SmartScreen 拦截。

**待办**：
- [ ] 注册 Apple Developer Program（$99/年），获取 Developer ID Application 证书
- [ ] 在 Forge 配置中加入 `osxSign` 和 `osxNotarize`（需 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`）
- [ ] Windows：购买代码签名证书（OV ~$200/年，EV ~$400/年）
- [ ] 配置 Windows Authenticode 签名（`signtool` 或 electron-builder 的 `win.signingHashAlgorithms`）

### 1.3 ⏳ iOS App Store 合规

**核心冲突**：iOS App Store **强制要求使用 Apple IAP**，不能直接跳 Stripe 网页支付，否则审核必拒。Apple 抽成 15%（年收入 <100 万美元的小开发者）~ 30%（标准）。

**待办**：
- [ ] 决策：iOS 是否上架？（如果只做 PWA + Android + Desktop，可暂时回避 IAP）
- [ ] 如上架 iOS：集成 `react-native-iap` / `Capacitor` + StoreKit 2，新建一套 IAP 产品
- [ ] 后端：扩展 `stripe-webhook` 或新建 Apple App Store Server Notification handler，处理 IAP 订阅状态
- [ ] 套餐映射：Apple Product ID → VoiceBridge plan（free / pro）
- [ ] 苹果审核材料：隐私政策 URL、用户协议 URL、应用截图、演示账号

### 1.4 ⏳ Google Play 合规

Google Play 允许使用 Google Play Billing（抽成 15%~30%），或（仅限欧盟用户）Alternative Billing。

**待办**：
- [ ] 注册 Google Play Developer 账号（$25 一次性）
- [ ] 决策支付方案：Google Play Billing vs 延续 Stripe（PWA 模式）
- [ ] 如用 Google Play Billing：集成 `@cordova-plugin/inappbrowser` 或 Capacitor Billing Client
- [ ] AAB 上传格式准备（需 `bundletool`）

### 1.5 ✅ 隐私政策 + 用户协议（已完成 2026-07-30）

- ✅ 起草隐私政策 `privacy.html`（涵盖：账户信息、录音即时丢弃、文本不持久化、用量记录、第三方服务清单）
- ✅ 起草用户协议 `terms.html`（涵盖：套餐配额、订阅条款、行为规范、免责声明）
- ✅ 部署到 Cloudflare Pages：
  - 隐私政策：https://voicebridge-6kr.pages.dev/privacy.html
  - 用户协议：https://voicebridge-6kr.pages.dev/terms.html
- ✅ 两份镜像同步（`hosted-pwa/public/` + `src/public/`）
- ✅ 在 PWA 和 Electron 应用内提供入口（2026-07-30 完成）
  - PWA `index.html`：底部加了 `.legal-footer`（隐私政策 · 用户协议），含 i18n 中英双语
  - Electron `renderer.html`：footer 加了隐私政策 · 用户协议 · 版本号链接

### 1.6 🟡 录音权限说明文案

iOS / Android / macOS 都要求在 Info.plist / AndroidManifest / Electron Info.plist 中明确说明为什么需要录音：

- [x] iOS `NSMicrophoneUsageDescription` 和本地网络权限声明
- [x] Android `RECORD_AUDIO`、网络和网络状态权限声明
- [ ] 录音数据处理方式说明（仅上传至你的 Supabase 用于 ASR，不做其他用途）

---

## 2. P1：商业化必要工作

### 2.1 ⏳ Stripe 订阅端到端验证

现有代码：
- Edge Function `billing-create-checkout-session` ✅
- Edge Function `stripe-webhook`（幂等）✅
- Edge Function `billing-create-portal-session` ✅
- 前端 `billing.js`（仅跳转）✅

**待办**：
- [ ] 配置 Stripe Test Mode 完整走通：订阅 → 续费 → 退订 → 重新订阅
- [ ] 验证 `subscriptions` 表状态同步正确
- [ ] 验证 `reserve_and_get_plan()` 在 pro / free / admin 三档下的行为
- [ ] 验证配额（`free: 600s/月`、`pro: 18000s/月`、`admin: 无限`）实际生效
- [ ] 上线前切换到 Stripe Live Mode（`STRIPE_SECRET_KEY` 和 `STRIPE_WEBHOOK_SECRET` 改为 `sk_live_*` / `whsec_*`）

### 2.2 ⏳ 多平台构建产物

当前已有 macOS arm64 App、自用 Android debug APK 和 iOS 原生工程/模拟器构建。正式分发仍需要：

- [ ] macOS Universal Binary（arm64 + x64）
- [ ] macOS DMG 安装包（`@electron-forge/maker-dmg`）
- [ ] Windows x64 NSIS 安装包（`@electron-forge/maker-squirrel`）或 MSI
- [ ] （可选）Linux deb / AppImage（`@electron-forge/maker-deb`）
- [ ] 在 GitHub Actions 配置跨平台构建矩阵
- [ ] iOS 真机选择 Apple Development Team 并完成签名、安装和局域网证书验收
- [ ] Android 生成正式签名 AAB/APK，并在真实设备完成录音、云端重连和局域网验收

### 2.3 ⏳ 自动更新

当前完全没有自动更新机制。已发布版本无法推送修复。

**待办**：
- [ ] 选型：`update.electronjs.org`（免费、开源）vs `Squirrel.Mac` / `Squirrel.Windows` 自建
- [ ] 集成 `electron-updater` 或 Forge 的 auto-update plugin
- [ ] 配置 `publish` provider（GitHub Releases 或自建静态托管）
- [ ] 测试 delta 更新和 full 更新

---

## 3. P2：代码加固（推荐但不阻塞发布）

### 3.1 bytenode 字节码保护

- [ ] 把 `main.js`、`realtimeAgent.js`、`cli.js` 编译成 `.jsc`
- [ ] 入口改为加载 `.jsc` 的 loader
- [ ] 注意：asar 内的 `.jsc` 需要特殊处理（`asarUnpack` 或运行时解包）

### 3.2 javascript-obfuscator

- [ ] 对 `renderer.html` 内联 JS 做混淆（asar 保护不了 HTML）
- [ ] 在 `premake` 钩子中加入混淆步骤

### 3.3 CI 防护

- [ ] GitHub Actions 加入 `gitleaks` / `secretlint` 扫描步骤
- [ ] 在 PR 检查中阻止 `.env` 内容、`sk_live_*`、`sb_secret_*` 提交

---

## 4. P3：产品化（可延后）

- [ ] 崩溃上报 / 匿名遥测（Sentry 或自建）
- [ ] 用户反馈渠道（应用内反馈按钮 + 邮箱）
- [ ] E2E 测试（Playwright / WebdriverIO）
- [ ] GitHub Actions CI（跨平台构建 + 测试）
- [ ] 官网落地页（`voicebridge.app`）
- [ ] 应用商店 ASO 优化（关键词、截图、描述）

---

## 5. 已澄清的架构事实

| 问题 | 答案 |
|------|------|
| 本地版和云端版冲突吗？ | 不冲突，共用账号与权益，传输链路独立 |
| 打包后的 app 是云端版吗？ | 同时支持云端；pro/admin 还会启用局域网直连 |
| Free 能使用局域网配对码吗？ | 不能；桌面端不会为 free 启动局域网服务 |
| 用户能逆向出源码吗？ | 之前能（裸明文），启用 asar 后门槛提高，但仍可解包 |
| 有安全隐患吗？ | 之前有（Cloudflare 账户信息泄露），已修复；密钥本身（Tencent/Stripe/Service Role）从未泄露 |
| Supabase anon key 泄露吗？ | 不算，按设计就是公开的，安全靠 RLS 保障 |

---

## 6. 待用户决策的开放问题

1. **iOS 是否上架？** → 决定是否需要做 Apple IAP（投入大、抽成高）
2. **Android 走哪个分发渠道？** → Google Play（需 Billing） vs 直接 APK 分发（可保留 Stripe）
3. **代码签名预算？** → Apple $99/年 + Windows $200~400/年
4. **是否需要官网？** → 应用商店审核通常需要官网 + 隐私政策 URL
5. **自动更新是否必须在首版上线？** → 影响发布节奏
