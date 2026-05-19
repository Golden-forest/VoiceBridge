# VoiceBridge

VoiceBridge 是一个本地版跨设备语音输入桥 MVP：电脑启动本地服务，手机扫码打开网页录音，音频回传到电脑，电脑端调用腾讯云一句话识别转成文字，再把结果写入系统剪切板。开启自动粘贴时，电脑端会尝试把剪切板内容粘贴到当前活动输入框。

第一版只面向局域网，不做账号、公网服务、App、数据库或真正的系统输入法。后续可以再扩展本地 faster-whisper / whisper.cpp。

## 当前能力

- 电脑端启动 HTTP 服务并监听 `0.0.0.0:${PORT}`。
- 自动寻找局域网 IP，并在终端输出手机访问地址和二维码。
- 手机端页面支持“按住说话”录音、上传音频、显示识别状态和结果。
- 手机端保留“自动粘贴 / 仅复制到剪切板”开关。
- 后端把手机录音统一转成 16k 单声道 wav，再调用腾讯云 `SentenceRecognition`。
- 腾讯云 Secret 只从本地 `.env` 读取，不会进入前端代码。
- 识别后先写入电脑剪切板；自动粘贴失败时仍保留剪切板兜底。
- WebSocket 推送连接状态、识别状态、识别结果和输出状态。

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

## 启动

```bash
npm start
```

终端会显示类似：

```text
VoiceBridge is running.
Local:   http://localhost:3000
Phone:   http://192.168.x.x:3000
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
curl http://127.0.0.1:3000/api/health
```

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
      style.css
  tmp/
```

## Roadmap

- 本地 faster-whisper / whisper.cpp 模式。
- 长按录音 / 点击开始停止两种模式。
- AI 自动标点和润色。
- 专业词热词表。
- 语音命令，例如“换行”“删除上一句”“发送”。
- 桌面托盘程序。
- 硬件麦克风设备接入。
- 跨公网连接。
- 移动端 PWA。
- 多 ASR 服务商切换。
