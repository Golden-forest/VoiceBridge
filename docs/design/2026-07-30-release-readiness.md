# VoiceBridge 发布前工作清单

> **作者**：lin
> **日期**：2026-07-30
> **状态**：进行中
> **关联历史**：项目接近尾声，需要接入支付、上架各大应用商店。本文档梳理从"功能开发完成"到"可公开发布"之间的全部必要工作。

---

## 0. 本地版 vs 云端版：不冲突

| 维度 | Local Mode | Cloud Mode |
|------|-----------|------------|
| 入口 | `npm start`（express HTTPS） | Electron 桌面 App + Supabase Realtime |
| 通讯 | 局域网 WebSocket | Supabase Realtime 跨网 |
| ASR | 本地 `.env` 直调腾讯云 | Supabase Edge Function `/transcribe` |
| 鉴权 | 无（局域网信任） | Supabase auth + 套餐配额 + Stripe |

两种模式是**独立运行**的，共用部分代码（`shared/`、`agent/`、`server/input/`）。Electron 桌面 App **只走 cloud 模式**（`main.js` 只加载 `renderer.html`，不启 express），`src/server/` 运行时不加载。**不存在冲突**。

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

### 1.6 ⏳ 录音权限说明文案

iOS / Android / macOS 都要求在 Info.plist / AndroidManifest / Electron Info.plist 中明确说明为什么需要录音：

- [ ] `NSMicrophoneUsageDescription`：中文 + 英文文案
- [ ] Android `RECORD_AUDIO` 权限说明
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

当前只有 macOS arm64 zip。上架需要：

- [ ] macOS Universal Binary（arm64 + x64）
- [ ] macOS DMG 安装包（`@electron-forge/maker-dmg`）
- [ ] Windows x64 NSIS 安装包（`@electron-forge/maker-squirrel`）或 MSI
- [ ] （可选）Linux deb / AppImage（`@electron-forge/maker-deb`）
- [ ] 在 GitHub Actions 配置跨平台构建矩阵

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
| 本地版和云端版冲突吗？ | 不冲突，独立运行，共用部分代码 |
| 打包后的 app 是云端版吗？ | 是，Electron 桌面端只走 cloud 模式 |
| app 里包含本地模式代码吗？ | 物理包含（已通过 ignore 规则修复），运行时不加载 |
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
