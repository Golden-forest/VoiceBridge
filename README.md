# VoiceBridge

把手机变成电脑的语音输入遥控器：手机录音和编辑文字，电脑负责剪切板、窗口选择与自动粘贴。包含静态网页、Electron 桌面端、Capacitor iOS/Android 工程及 Supabase 云端。

## 当前使用流程

1. 电脑启动 VoiceBridge Agent，显示绑定二维码。
2. 手机打开 [网页版](https://voicebridge.heyflint.top/app)，登录后扫码确认绑定。桌面无需输入真实账号密码。
3. 手机选择已绑定且在线的电脑，将电脑光标放到目标输入框，点击录音，再点击停止。
4. 转写结果显示在手机文本框；自动粘贴开启时发送到录音开始时选择的目标。识别期间切换账号、电脑或修改草稿时，保留可恢复结果，不自动改送其他目标。
5. 自动粘贴失败时可使用电脑剪切板。指定窗口失效时停止自动粘贴，避免进入其他窗口。

桌面持久化独立匿名运行身份；手机是用户登录端。云端使用私有 Realtime 通道。Pro/admin 桌面可以开启局域网服务，free 使用云端。LAN 需输入电脑显示的配对码，退出绑定后旧凭据失效。

## 开发与运行

需要 Node.js 22.18+（22.x）或 24+；测试直接使用 Node 的 TypeScript 支持。移动工程另需本机 Xcode/Android SDK 和 Capacitor 对应环境。

```bash
npm install
npm --prefix mobile install
```

### 桌面 App

打包配置只包含公开 Supabase URL/publishable key。设置配置后运行：

```bash
VOICEBRIDGE_DESKTOP_SUPABASE_URL=https://vb-api.heyflint.top \
VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY=PUBLIC_KEY_HERE \
npm run electron:write-config
npm run electron:start
```

构建安装包：

```bash
npm run make -- --arch=arm64
```

产物位于 `out/make`。不把 Tencent、Paddle、Stripe 或 service-role secret 放进安装包。正式签名、公证、自动更新和跨平台发布需另行验收。

### 独立本地服务

复制 `.env.example` 到未提交的 `.env`，设置自己的 Tencent SecretId/SecretKey，然后运行：

```bash
npm start
```

终端显示 HTTPS 地址、二维码及配对码。手机与电脑同网段，完成证书信任与配对后使用。健康检查无需配对：

```bash
curl -k https://127.0.0.1:3000/api/health
```

浏览器直接生成 16 kHz 单声道 WAV；非标准音频的转换需要可执行的 ffmpeg，可用 `FFMPEG_PATH` 指定。所有控制请求（包括本机）都需配对凭据；健康接口不是控制权限。

`npm run agent` 保留为开发用旧式邮箱密码 CLI，需要 `.env` 中的 Supabase 配置和 `VOICEBRIDGE_AGENT_EMAIL/PASSWORD`；普通用户使用扫码 Electron 流程。

### Hosted PWA 与原生移动端

```bash
npm --prefix hosted-pwa run build
npm run mobile:prepare
npm --prefix mobile run sync
npm --prefix mobile run open:ios
# 或 npm --prefix mobile run open:android
```

网页源在 `src/public`，云端镜像在 `hosted-pwa/public`，构建校验内容一致。官网通过 `hosted-pwa/landing/template.html` 和两份 locale 生成。原生包使用 `mobile/www` 中的本地构建资源，需重新 prepare/sync 才会包含修复；无需运行时前端 CDN。

## 云端与计费

Supabase secrets 与本地 `.env` 分开管理。服务器所需变量以 `.env.example` 和云函数配置校验为准，不把 secret 放入网页 `config.js`。

- 转写统一通过 `/transcribe` 可信转发，时长由服务器校验 WAV 得到。LAN 桌面传 `device_id` 与运行身份，服务器确认绑定后向真实账号结算。
- `issue-asr-request` 和 `report-asr-result` 已退役，返回 410，不再向客户端发出腾讯签名或接受其修改额度。
- 结果未知的请求保留可审计状态并保守计入用量，不能通过伪报失败退款；过期 processing 请求由服务端处理。
- 新 Checkout 默认 Paddle；Stripe 仅为遗留迁移通道。Webhook 用严格 RPC 契约处理失败和重试。
- 删号先确认所有可能扣费的外部订阅取消；任一失败保留账号和关联，供重试。
- 删号与购买共用数据库锁：有未结束的 Checkout 时保留账号；删号意图生效后禁止新购买。取消失败可重试删号，重新购买需先核对并解除删号状态。
- 未确认结果的 Checkout 不重新创建另一笔交易，需要核对支付商状态。
- Paddle 支付完成通知先到、订阅事实尚未确认时，保留账号关联并暂缓删号和再次购买，等待可信订阅回调。

## 验证

一条命令执行源码行为测试、hosted 构建/镜像与产物检查、移动资源准备/检查，以及部署清单校验：

```bash
./scripts/verify
```

定向命令：

```bash
npm test
npm --prefix hosted-pwa test
npm run mobile:prepare
npm --prefix mobile test
node scripts/edge-functions.mjs
VOICEBRIDGE_TEST_POSTGRES=1 node --test supabase/functions/_shared/postgres_hardening.test.js
deno check --frozen supabase/functions/transcribe/index.ts supabase/functions/account-delete/index.ts supabase/functions/paddle-webhook/index.ts supabase/functions/stripe-webhook/index.ts supabase/functions/billing-create-checkout-session/index.ts supabase/functions/issue-asr-request/index.ts supabase/functions/report-asr-result/index.ts
```

`npm test` 串行测试源码，排除生成副本，避免重复数量和旧产物掩盖问题。测试输出器必须使用桩，不操作真实剪切板/系统按键或真实付费服务。

PostgreSQL 测试需本机 `initdb/pg_ctl/psql`，默认查找 `/opt/homebrew/opt/postgresql@15/bin`，可用 `VOICEBRIDGE_POSTGRES_BIN` 指定。它只在 `/tmp` 创建隔离数据库并自动清理；未显式启用时普通测试会显示 skip。完整数据库验收可运行 `VOICEBRIDGE_TEST_POSTGRES=1 ./scripts/verify`。

Lint/typecheck：无独立 JS lint 配置；云函数使用 Deno 检查，行为/SQL 契约由测试覆盖。原生编译与真实权限不属于上述静态移动检查。

浏览器人工验收：登录/登出、A/B账号切换、两台电脑切换、录音双击、识别中改目标/草稿、断网恢复、LAN解绑及旧token失效；检查手机尺寸、控制台、结果恢复入口。真实手机麦克风、系统粘贴及支付需单独验收，不能用静态字符串测试替代。

可重复的离线界面验收：运行 `node scripts/browser-fixture.mjs`，打开 `http://127.0.0.1:3123/app`。底部按钮切换模拟账号和完成延迟识别；录音双击后看 mic 申请/活跃数量，停止后修改草稿或目标，再完成识别检查恢复区。所有身份、音频和输入均为本地模拟，不访问真实麦克风、账号或服务。浏览器点击验收仍需人工执行。

生产状态检查默认只读，不签发 ASR、不生成用量、不尝试修改设备：

```bash
node scripts/verify-production.mjs
```

它使用桌面 bundled config 和 `~/.voicebridge` 的运行会话，可用 `VOICEBRIDGE_STATE_DIR` 指定目录。显式 `--check-write-authorization` 才会尝试真实 PATCH 权限探测；不能把这个选项当作事务回滚，也不放进离线 verify。

## 部署

`supabase/config.toml` 是 Edge Function 唯一清单；部署脚本会检查与实现目录一致，包括 account-delete。数据库迁移须先于依赖它的云函数；本轮 LAN 转发接口变化需要新桌面端配合，旧签名客户端收到 410 后需升级。

```bash
bash scripts/deploy.sh db
bash scripts/deploy.sh functions
bash scripts/deploy.sh frontend
```

这些命令会写入远端，只在明确授权发布时执行。Live Paddle 前端仍要求已有发布门 `PADDLE_LIVE_DEPLOY_APPROVED=1`，不要用它跳过实际支付验收。

## 项目地图

- `src/public/`：录音、登录、设备选择与私人指令。
- `src/agent/`：运行身份、Electron 生命周期和 Realtime。
- `src/server/`：LAN、音频转换、共享桌面输入队列。
- `src/shared/`：协议和套餐限制。
- `supabase/functions/`、`supabase/migrations/`：鉴权、可信转写、计费事务与数据库约束。
- `hosted-pwa/`：静态官网/PWA构建与部署资源。
- `mobile/`：原生工程和可再生成的网页包。
- `scripts/verify`：离线验收入口；`scripts/deploy.sh`：明确授权的发布入口。
