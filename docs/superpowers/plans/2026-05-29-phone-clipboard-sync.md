# 手机剪切板同步 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在手机端 VoiceBridge Web 页面发送内容到电脑时，同步将内容写入手机剪切板。

**Architecture:** 纯前端改动。新增一个 `copyToPhoneClipboard()` 工具函数，在文本发送和指令点击的用户手势事件中直接调用（自动），在语音识别结果的 toast 中嵌入复制按钮（手动点击一次）。服务端无需任何改动。

**Tech Stack:** Web Clipboard API (`navigator.clipboard.writeText`) + `document.execCommand('copy')` fallback + Vanilla JS

---

### Task 1: 新增 `copyToPhoneClipboard()` 工具函数

**Files:**
- Modify: `src/public/app.js:10-19` (在 Toast section 之前插入)

- [ ] **Step 1: 在 Toast section 之前添加 `copyToPhoneClipboard` 函数**

在 `src/public/app.js` 第 10 行 (`// === Toast ===`) 之前，插入以下代码：

```javascript
// === Phone Clipboard ===
async function copyToPhoneClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      // 静默失败，不影响主流程
    }
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/public/app.js
git commit -m "feat(phone-clipboard): add copyToPhoneClipboard utility with fallback"
```

---

### Task 2: 文本输入发送时自动写入手机剪切板

**Files:**
- Modify: `src/public/app.js:58-85` (`sendTextInput` 函数)

- [ ] **Step 1: 在 `sendTextInput()` 中添加手机剪切板调用**

在 `src/public/app.js` 的 `sendTextInput()` 函数中，在 `ws.send(JSON.stringify(msg))` 这一行（第 77 行）之前，添加一行调用：

将：
```javascript
    ws.send(JSON.stringify(msg));
    textInput.value = "";
    updateTextInputState();
    lastAutoPastedText = "";
    showToast("已发送到电脑。");
```

改为：
```javascript
    copyToPhoneClipboard(text);
    ws.send(JSON.stringify(msg));
    textInput.value = "";
    updateTextInputState();
    lastAutoPastedText = "";
    showToast("已发送到电脑。");
```

- [ ] **Step 2: 提交**

```bash
git add src/public/app.js
git commit -m "feat(phone-clipboard): auto-copy text input to phone clipboard on send"
```

---

### Task 3: 快捷指令/常用语发送时自动写入手机剪切板

**Files:**
- Modify: `src/public/app.js:316-325` (`PhrasesManager._sendPhrase`)
- Modify: `src/public/app.js:474-484` (`sendQuickCommand`)

- [ ] **Step 1: 在 `_sendPhrase()` 中添加手机剪切板调用**

在 `src/public/app.js` 的 `_sendPhrase()` 方法中，在 `ws.send(JSON.stringify(msg))` 这一行（第 320 行）之前，添加调用：

将：
```javascript
  _sendPhrase(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg = { type: "phrase", text, autoPaste: autoPasteEl.checked };
      if (windowSelector.targetWindow) msg.targetWindow = windowSelector.targetWindow;
      ws.send(JSON.stringify(msg));
```

改为：
```javascript
  _sendPhrase(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg = { type: "phrase", text, autoPaste: autoPasteEl.checked };
      if (windowSelector.targetWindow) msg.targetWindow = windowSelector.targetWindow;
      copyToPhoneClipboard(text);
      ws.send(JSON.stringify(msg));
```

- [ ] **Step 2: 在 `sendQuickCommand()` 中添加手机剪切板调用**

在 `src/public/app.js` 的 `sendQuickCommand()` 函数中，在 `ws.send(JSON.stringify(msg))` 这一行（第 478 行）之前，添加调用：

将：
```javascript
    ws.send(JSON.stringify(msg));
    recentCommands.record(text, label || text);
```

改为：
```javascript
    copyToPhoneClipboard(text);
    ws.send(JSON.stringify(msg));
    recentCommands.record(text, label || text);
```

- [ ] **Step 3: 提交**

```bash
git add src/public/app.js
git commit -m "feat(phone-clipboard): auto-copy phrases and quick commands to phone clipboard"
```

---

### Task 4: 语音识别结果 Toast 添加复制按钮

**Files:**
- Modify: `src/public/app.js:13-19` (`showToast` 函数，新增 `showCopyToast`)
- Modify: `src/public/app.js:700` (`uploadAudio` 中的 toast 调用)
- Modify: `src/public/style.css` (toast 内嵌按钮样式)

- [ ] **Step 1: 在 `showToast` 函数之后新增 `showCopyToast` 函数**

在 `src/public/app.js` 的 `showToast` 函数（第 13-19 行）之后，添加：

```javascript
function showCopyToast(message, copyText) {
  clearTimeout(toastTimer);
  toastEl.classList.remove("error");
  toastEl.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = message;
  toastEl.appendChild(span);
  const btn = document.createElement("button");
  btn.className = "toast-copy-btn";
  btn.type = "button";
  btn.textContent = "复制到手机";
  btn.addEventListener("click", () => {
    copyToPhoneClipboard(copyText);
    btn.disabled = true;
    btn.textContent = "已复制";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1500);
  });
  toastEl.appendChild(btn);
  toastEl.classList.add("show");
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4000);
}
```

- [ ] **Step 2: 替换 `uploadAudio` 中的语音结果 toast**

将 `src/public/app.js` 第 700 行：

```javascript
    showToast(output.pasted ? "已复制并自动粘贴。" : "已复制到电脑剪切板。");
```

改为：

```javascript
    if (output.pasted) {
      showToast("已复制并自动粘贴。");
    } else {
      showCopyToast("已复制到电脑剪切板。", payload.text || "");
    }
```

注意：这里需要用 `payload.text`（识别出的原始文本）而非 `output.text`（output 对象上不一定有 text 字段）。先确认 `payload` 结构：从 `upload.js` 服务端返回的是 `{ ok, output: { copied, pasted, pasteError } }` 和 `payload.text`（识别文本）。查看 `src/server/routes/upload.js` 确认返回的 JSON 中文本字段名。

如果服务端返回的 JSON 中识别文本在 `payload.text`，则使用 `payload.text`。如果不在，需要检查 `upload.js` 返回结构并相应调整。

- [ ] **Step 3: 替换 WS output 消息中的 toast（非自动粘贴场景）**

将 `src/public/app.js` 第 732-734 行：

```javascript
      if (payload.type === "output" && payload.copied && !payload.pasted) {
        showToast(payload.pasteError ? "已复制，自动粘贴失败。" : "已复制到剪切板。", Boolean(payload.pasteError));
      }
```

改为：

```javascript
      if (payload.type === "output" && payload.copied && !payload.pasted) {
        if (payload.pasteError) {
          showToast("已复制，自动粘贴失败。", true);
        } else if (payload.text) {
          showCopyToast("已复制到剪切板。", payload.text);
        }
      }
```

- [ ] **Step 4: 添加 toast 复制按钮样式**

在 `src/public/style.css` 的 `.toast.error` 样式（第 422-425 行附近）之后，添加：

```css
.toast-copy-btn {
  background: rgba(255, 255, 255, 0.15);
  color: inherit;
  border: none;
  padding: 4px 10px;
  margin-left: 8px;
  border-radius: 4px;
  font-size: 0.75em;
  cursor: pointer;
  white-space: nowrap;
}

.toast-copy-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 5: 提交**

```bash
git add src/public/app.js src/public/style.css
git commit -m "feat(phone-clipboard): add copy button to voice result toast for phone clipboard sync"
```

---

### Task 5: 验证与收尾

- [ ] **Step 1: 启动服务并在手机浏览器中测试**

1. `npm start` 启动服务
2. 手机扫码打开页面
3. 测试文本输入 → 点击发送 → 切换到手机其他 App 尝试粘贴，应能看到发送的文字
4. 测试快捷指令 → 点击指令按钮 → 切换到手机其他 App 尝试粘贴
5. 测试语音识别 → 识别完成后 toast 出现"复制到手机"按钮 → 点击 → 切换到手机其他 App 尝试粘贴
6. 测试常用语 → 点击常用语 → 切换到手机其他 App 尝试粘贴

- [ ] **Step 2: 提交设计文档**

```bash
git add docs/superpowers/specs/2026-05-29-phone-clipboard-sync-design.md
git commit -m "docs: add phone clipboard sync design spec"
```
