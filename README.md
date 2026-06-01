# VoiceBridge

VoiceBridge 是一个跨设备语音输入桥 MVP：电脑端负责写入剪切板和自动粘贴，手机端负责录音和发送文字。默认 local mode 仍然是局域网内直连；cloud mode 增加 Supabase 登录、同账号设备发现、跨网络 Realtime 通讯、云端 ASR 配额和 Stripe 订阅。

后续可以继续扩展本地 faster-whisper / whisper.cpp，把 ASR 成本进一步摊低。

## 当前能力

- 电脑端启动 HTTPS 服务并监听 `0.0.0.0:${PORT}`，同时启动 `PORT+1` 的 HTTP 重定向服务。
- 自动寻找局域网 IP，并在终端输出手机访问地址和二维码。
- 手机端页面支持“按住说话”录音、上传音频、显示识别状态和结果。
- 手机端保留“自动粘贴 / 仅复制到剪切板”开关。
- 后端把手机录音统一转成 16k 单声道 wav，再调用腾讯云 `SentenceRecognition`。
- 腾讯云 Secret 只从本地 `.env` 或 Supabase Edge Function secrets 读取，不会进入前端代码。
- 识别后先写入电脑剪切板；自动粘贴失败时仍保留剪切板兜底。
- WebSocket 推送连接状态、识别状态、识别结果和输出状态。
- Cloud mode 下，手机网页和桌面 Agent 登录同一个 Supabase 账号后，可以通过 Realtime 私有频道跨网络发送文本。
- Cloud mode 录音会调用 Supabase Edge Function `/transcribe`，按订阅方案记录用量并做免费额度限制。
- Stripe Checkout、Customer Portal 和 webhook 用于升级 Pro 订阅。

## 安装

需要 Node.js 20 或更高版本。

```bash
npm install
```

电脑端需要可执行的 `ffmpeg`，用于把浏览器录制的 webm/m4a 转成腾讯云更稳的 wav。本机已检测到 `/opt/homebrew/bin/ffmpeg`，所以 `.env` 里可以设置 `FFMPEG_PATH=/opt/homebrew/bin/ffmpeg`。其他机器如果没有安装，可用 Homebrew、Scoop、apt 等方式安装后再配置。

## 配置

本地 `.env` 已按你提供的腾讯云密钥创建，且 `.env` 已在 `.gitignore` 中，不会被提交。

配置项如下：

```bash
ASR_PROVIDER=tencent
TENCENT_SECRET_ID=你的 SecretId
TENCENT_SECRET_KEY=你的 SecretKey
TENCENT_ASR_REGION=ap-shanghai
TENCENT_ASR_ENG_SERVICE_TYPE=16k_zh
FFMPEG_PATH=/opt/homebrew/bin/ffmpeg
PORT=3000
AUTO_PASTE=true
```

通常还需要确认腾讯云控制台里已经开通“语音识别 ASR”服务，并且这组密钥有调用语音识别 API 的权限。`TENCENT_ASR_ENG_SERVICE_TYPE=16k_zh` 是中文普通话 16k 通用识别；后续要换英文、粤语或其他模型时，再按腾讯云官方文档调整。

腾讯云一句话识别官方限制：适合 60 秒以内短音频，本地上传音频文件大小不超过 3MB，支持 wav、pcm、ogg-opus、mp3、m4a、aac、amr 等格式。VoiceBridge 会自动转 wav，并在手机端把单次录音限制在约 55 秒内。

## Cloud Mode

Cloud mode 让手机网页和桌面 Agent 通过同一个 Supabase 账号连接，即使不在同一个局域网内也可以通信。local mode 不依赖这些配置，仍然可以按上面的方式独立运行。

需要的环境变量：

```bash
VOICEBRIDGE_MODE=cloud

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_PROJECT_ID=

VOICEBRIDGE_AGENT_EMAIL=
VOICEBRIDGE_AGENT_PASSWORD=

VOICEBRIDGE_DESKTOP_SUPABASE_URL=
VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY=

TENCENT_SECRET_ID=
TENCENT_SECRET_KEY=
TENCENT_ASR_REGION=ap-shanghai
TENCENT_ASR_ENG_SERVICE_TYPE=16k_zh

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRO_MONTHLY_PRICE_ID=
STRIPE_SUCCESS_URL=http://localhost:3000/?billing=success
STRIPE_CANCEL_URL=http://localhost:3000/?billing=cancel
```

启动桌面 Agent：

```bash
VOICEBRIDGE_MODE=cloud npm run agent
```

启动网页：

```bash
VOICEBRIDGE_MODE=cloud npm start
```

桌面 Agent 会使用 `VOICEBRIDGE_AGENT_EMAIL` 和 `VOICEBRIDGE_AGENT_PASSWORD` 登录 Supabase，并注册为当前账号下的 desktop device。手机端网页登录同一个账号后，会优先选择 desktop device 发送文字。

Electron 桌面 App 不需要 service role key 或 Stripe/Tencent secret。打包发布前，需要把公开的 Supabase URL 和 anon key 配成 `VOICEBRIDGE_DESKTOP_SUPABASE_URL` / `VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY`，这样用户下载后只需要输入自己的账号密码。

需要部署的 Supabase 资源：

- `supabase/migrations/0001_cloud_core.sql`
- `supabase/migrations/0002_transcribe_usage_reservations.sql`
- `supabase/functions/transcribe`
- `supabase/functions/billing-create-checkout-session`
- `supabase/functions/billing-create-portal-session`
- `supabase/functions/stripe-webhook`

Stripe webhook 需要配置为不校验 Supabase JWT；其他 Edge Functions 需要登录态 JWT。

当前 Supabase 项目：

```text
VoiceBridge: gqxxknusznbunkiznnal
```

当前已部署的 Edge Functions：

- `transcribe` (`verify_jwt=true`)
- `billing-create-checkout-session` (`verify_jwt=true`)
- `billing-create-portal-session` (`verify_jwt=true`)
- `stripe-webhook` (`verify_jwt=false`)

上线前还需要在 Supabase 项目中设置真实 Stripe/Tencent secrets，并在 Stripe Dashboard 配置 webhook URL。

## Desktop Agent App

开发模式启动 Electron 壳：

```bash
npm run electron:start
```

生成本机安装包：

```bash
VOICEBRIDGE_DESKTOP_SUPABASE_URL=https://gqxxknusznbunkiznnal.supabase.co \
VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY=SUPABASE_ANON_KEY_HERE \
npm run make -- --arch=arm64
```

构建产物会出现在 `out/make`。项目已配置 Electron 下载镜像，国内网络下首次构建会更稳一些。

## 启动

```bash
npm start
```

终端会显示类似：

```text
VoiceBridge is running.
Local:   https://localhost:3000
Phone:   https://192.168.x.x:3000
ASR:     tencent (16k_zh)
Paste:   auto paste enabled
```

用手机连接同一个 Wi-Fi，扫描终端二维码，或手动打开 `Phone` 地址。

## 使用

1. 电脑上运行 `npm start`。
2. 手机上打开二维码对应页面。
3. 电脑上把光标放到 ChatGPT、Word、微信、Obsidian、VS Code 或浏览器输入框。
4. 手机按住“按住说话”，松手后上传。
5. 等待识别结果。
6. 如果自动粘贴可用，文字会出现在当前输入框；否则文字已经进入电脑剪切板，可手动 `Cmd+V` / `Ctrl+V`。

## 测试

运行单元测试：

```bash
npm test
```

手动验收：

1. `npm start` 后确认终端出现局域网地址和二维码。
2. 手机扫码能打开页面，并看到“已连接电脑端”。
3. 手机按住录音，松手后页面进入“正在识别”。
4. 页面显示识别结果。
5. 关闭“自动粘贴”开关，再录音一次；电脑上手动粘贴，确认剪切板里是识别文本。

健康检查：

```bash
curl -k https://127.0.0.1:3000/api/health
```

Cloud mode 手动验收：

1. 在 Supabase 中创建一个测试账号，并确认桌面 Agent 和手机网页使用同一账号登录。
2. 启动 `VOICEBRIDGE_MODE=cloud npm run agent`。
3. 启动 `VOICEBRIDGE_MODE=cloud npm start`。
4. 手机网页选择桌面设备，发送一段 typed text。
5. 电脑端确认文字进入剪切板或自动粘贴到当前输入框。
6. 录音 5 秒，确认 `/transcribe` 返回 `{ "ok": true, "text": "..." }`。
7. 确认 `usage_events` 产生一条 `success` 记录。
8. 用 Stripe test mode 完成 Checkout，确认 webhook 写入 active subscription，随后 `/transcribe` 使用 Pro 限额。

## 常见问题

### 腾讯云鉴权失败

检查：

- `.env` 中的 `TENCENT_SECRET_ID` 和 `TENCENT_SECRET_KEY` 是否正确。
- 腾讯云控制台是否已经开通语音识别 ASR。
- 当前密钥是否有调用 ASR API 的权限。
- 电脑是否能访问 `https://asr.tencentcloudapi.com`。

### 识别返回参数或格式错误

VoiceBridge 会转成 `wav` 后上传。如果仍然失败，优先检查 `TENCENT_ASR_ENG_SERVICE_TYPE` 是否和语音内容匹配。默认 `16k_zh` 适合中文普通话。

### 手机无法直接录音

很多手机浏览器要求麦克风 API 运行在安全上下文。`http://192.168.x.x:3000` 在某些浏览器里可能无法直接调用 `getUserMedia`。页面会显示一个“录音或选择音频上传”的兜底按钮，可先用它跑通上传、识别、剪切板链路。

后续版本可以加入本地 HTTPS / 证书配置，让手机端录音更稳定。

### 麦克风权限被拒绝

在手机浏览器的站点设置里允许麦克风权限，然后刷新页面重试。

### 剪切板写入失败

`clipboardy` 会调用当前系统的剪切板能力。Linux 环境可能需要安装 `xclip`、`xsel` 或 `wl-clipboard` 一类工具，具体取决于桌面环境。

### 自动粘贴失败

自动粘贴是 best-effort：

- macOS 使用 AppleScript 模拟 `Cmd+V`，通常需要给 Terminal / iTerm / Codex 所在应用开启“辅助功能”权限：系统设置 -> 隐私与安全性 -> 辅助功能。
- Windows 使用 PowerShell `SendKeys` 模拟 `Ctrl+V`，有些高权限窗口或远程桌面窗口可能不接受。
- Linux 默认调用 `xdotool key ctrl+v`，需要安装 `xdotool`，Wayland 环境可能不支持。

失败时，VoiceBridge 仍会先把文字写入剪切板。

### 局域网无法访问

确认手机和电脑在同一 Wi-Fi，电脑防火墙允许 Node.js 入站连接，并且终端里的 `Phone` 地址不是 VPN、Docker 或虚拟网卡 IP。如果地址不对，可临时断开 VPN 后重启服务。

## 项目结构

```text
voicebridge/
  package.json
  .env.example
  README.md
  src/
    agent/
      cli.js
      realtimeAgent.js
      electron/
        main.js
        preload.cjs
        renderer.html
    shared/
      protocol.js
      planLimits.js
    server/
      index.js
      asr/
        audioConverter.js
        transcriber.js
        tencentCloudTranscriber.js
      input/
        clipboard.js
        paste.js
        outputText.js
      network/
        getLocalIp.js
      routes/
        upload.js
        uploadOptions.js
      ws.js
    public/
      index.html
      app.js
      auth.js
      cloudRealtime.js
      cloudRecorder.js
      style.css
  supabase/
    migrations/
    functions/
  tmp/
```

## Roadmap

- 本地 faster-whisper / whisper.cpp 模式。
- 长按录音 / 点击开始停止两种模式。
- AI 自动标点和润色。
- 专业词热词表。
- 语音命令，例如“换行”“删除上一句”“发送”。
- 桌面托盘程序和安装器签名。
- 硬件麦克风设备接入。
- 移动端 PWA。
- 多 ASR 服务商切换。
