# 手机剪切板同步设计

## 问题

VoiceBridge 在语音识别或文本发送后会将内容写入电脑系统剪切板，但手机端没有任何剪切板操作。用户希望在发送内容到电脑的同时，手机剪切板也能拥有相同内容，方便在手机其他 App 中粘贴使用。

## 技术约束

手机端是纯 Web 页面（非原生 App、非 PWA），所有现代手机浏览器的 Clipboard API (`navigator.clipboard.writeText()`) 要求在**用户手势**（点击、触摸）中调用。WebSocket 回调和 HTTP 异步响应不属于用户手势，无法在这些回调中直接写入手机剪切板。

## 方案

针对三种发送场景，采用"能自动则自动，不能则提供复制按钮"的策略：

| 场景 | 手机剪切板写入时机 | 自动/手动 |
|------|------------------|----------|
| 文本输入发送 | 点击"发送"按钮时，与 WS send 同一事件 | 自动 |
| 快捷指令/常用语 | 点击指令按钮时，与 WS send 同一事件 | 自动 |
| 语音识别结果 | 结果返回后，toast 中显示"复制"按钮 | 手动（点一下） |

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 服务端改动 | 无 | 剪贴板同步是纯前端行为，不涉及数据流变更 |
| 剪贴板 API 策略 | 优先 `navigator.clipboard`，fallback `execCommand` | 兼容性最大化 |
| 失败处理 | 静默忽略 | 不阻断"发送到电脑"的主流程 |
| 文本/指令场景提示 | 无 | 用户已在点击，顺带写入不需额外反馈 |
| 语音场景提示 | toast 内嵌"复制"按钮 | 最小侵入，用户可选择性复制 |

## 技术方案

### 新增工具函数

在 `src/public/app.js` 中新增 `copyToPhoneClipboard(text)`：

```
copyToPhoneClipboard(text)
  ├─ navigator.clipboard.writeText(text)    // 优先（HTTPS 环境）
  ├─ fallback: 创建隐藏 textarea，选中后 document.execCommand('copy')
  └─ 失败则 catch 静默返回
```

### 接入点 1：文本输入发送

文件：`src/public/app.js` — `sendTextInput()` 函数

在 `ws.send(JSON.stringify(msg))` 之前，调用 `copyToPhoneClipboard(text)`。因为由发送按钮的 click 事件触发，属于用户手势，Clipboard API 可正常调用。

### 接入点 2：快捷指令/常用语

文件：`src/public/app.js` — 指令按钮的点击事件处理

在发送 WS `phrase` 消息之前，调用 `copyToPhoneClipboard(text)`。同理，按钮点击属于用户手势。

### 接入点 3：语音识别结果

文件：`src/public/app.js` — 语音上传响应处理和 WS result 消息处理

语音识别结果异步返回，不在用户手势上下文中，因此：

1. 将现有的 `showToast("已复制到电脑剪切板。")` 替换为一个包含"复制"按钮的 toast
2. 用户点击"复制"按钮时，该 click 事件是用户手势，可正常调用 `copyToPhoneClipboard(text)`
3. 复制成功后 toast 更新为"已复制到手机剪切板。"，1.5 秒后自动消失

### Toast 改造

新增一个 `showCopyToast(message, copyText)` 函数或扩展现有 `showToast()`，支持在消息中嵌入可点击的复制按钮。仅语音场景使用，不影响其他 toast 调用。

## 不涉及的改动

- 服务端代码（`src/server/`）无需任何修改
- 电脑端剪切板逻辑（`clipboard.js`、`outputText.js`）不变
- 不引入 PWA 或 Service Worker
