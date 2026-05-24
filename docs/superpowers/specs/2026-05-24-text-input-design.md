# 文本输入框设计

## 问题

VoiceBridge 目前只有语音输入，识别结果为只读显示。说错了无法修改，且没有手动打字输入的能力。用户需要一个并行的文字输入方式，用于在手机上打字后发送到电脑。

## 方案

将现有的只读识别结果区替换为可编辑的 `<textarea>`，实现语音识别结果和手动打字共用一个文本框。纯客户端改动，服务端无需修改。

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 输入框位置 | 识别结果区域变身 | 一区两用，不增加界面复杂度 |
| 输入用途 | 长文本为主 | 手机打字发到电脑编辑器/聊天窗口 |
| 发送方式 | 手机键盘回车/发送键 | 利用原生输入法，无需额外按钮 |
| 语音结果写入方式 | 追加到末尾 | 不覆盖用户正在输入的内容 |
| 追加分隔 | 自动空格 | 末尾非标点时追加空格 |
| 发送后行为 | 清空文本框 | 符合"说完就发、打完就发"的节奏 |
| 换行支持 | 不支持（回车=发送） | 发送目标是电脑光标位置，单行足够 |

## 技术方案

### 服务端

无改动。复用现有 WebSocket `phrase` 消息：

```json
{ "type": "phrase", "text": "文本内容", "autoPaste": true, "targetWindow": { "appName": "...", "windowTitle": "..." } }
```

服务端收到后调用 `outputText()` → 剪贴板 → 粘贴到目标窗口。

### 客户端 HTML

**改动前：**
```html
<section class="result">
  <p id="resultText"></p>
</section>
```

**改动后：**
```html
<section class="result">
  <textarea id="textInput" placeholder="点击输入文字，或使用语音识别..."
            enterkeyhint="send" rows="1"></textarea>
</section>
```

### 客户端 JS

1. **发送逻辑**：监听 textarea 的 `keydown` 事件，`Enter` 键（非 Shift+Enter）触发发送：
   - 取 `textarea.value`，trim 后为空则忽略
   - 通过 WebSocket 发送 `{ type: "phrase", text, autoPaste, targetWindow }`
   - 清空 textarea
   - 隐藏收藏按钮

2. **语音结果追加**：WebSocket 收到 `result` 消息时：
   - 如果 textarea 为空 → 直接设置 value
   - 如果 textarea 有内容 → 追加到末尾，末尾非标点时先加空格

3. **收藏按钮适配**：
   - 监听 textarea 的 `input` 事件
   - 有内容时显示"收藏为常用语"按钮，无内容时隐藏
   - 点击收藏取 textarea 当前值

4. **移除旧逻辑**：
   - 删除原有的 `resultEl.textContent = payload.text` 赋值
   - 删除上传成功后设置 resultText 的逻辑

### 客户端 CSS

- textarea 外观与当前 result 区域一致（圆角、背景色）
- 高度自适应内容，最小 1 行，最大约 4-5 行（超出滚动）
- `enterkeyhint="send"` 让手机键盘显示"发送"键
- focus 时边框高亮为主色调 `#176b87`
- placeholder 颜色适配深色模式

## 涉及文件

| 文件 | 改动类型 |
|------|----------|
| `src/public/index.html` | `<p id="resultText">` → `<textarea id="textInput">` |
| `src/public/app.js` | 添加键盘发送、语音追加、收藏适配；移除旧的 resultText 赋值逻辑 |
| `src/public/style.css` | textarea 样式（自适应高度、focus、深色模式） |
