# 文本输入框 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将只读识别结果区替换为可编辑 textarea，支持手动打字输入并通过手机键盘回车键发送到电脑。

**Architecture:** 纯客户端改动。将 `<p id="resultText">` 替换为 `<textarea id="textInput">`，复用现有 WebSocket `phrase` 消息通道发送文本，无需服务端修改。

**Tech Stack:** 原生 HTML/CSS/JS（与现有项目一致）

---

### Task 1: HTML — 替换 result 区域为 textarea

**Files:**
- Modify: `src/public/index.html:141-148`

- [ ] **Step 1: 修改 result section**

将 `index.html` 第 141-148 行的 `<section class="result">` 替换为：

```html
        <section class="result">
          <div class="result-label">输入 / 识别结果</div>
          <textarea id="textInput" class="text-input" placeholder="点击输入文字，或使用语音识别…" enterkeyhint="send" rows="1"></textarea>
          <button id="savePhraseBtn" class="save-phrase-btn hidden" type="button">
            <svg viewBox="0 0 24 24" width="16" height="16"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            收藏为常用语
          </button>
        </section>
```

- [ ] **Step 2: 确认页面可正常加载**

Run: `node src/server/index.js`（在浏览器打开页面确认 textarea 显示正常）

- [ ] **Step 3: Commit**

```bash
git add src/public/index.html
git commit -m "feat(text-input): replace resultText with editable textarea"
```

---

### Task 2: CSS — textarea 样式

**Files:**
- Modify: `src/public/style.css:220-236`

- [ ] **Step 1: 替换 #resultText 样式为 .text-input 样式**

删除 `style.css` 中 `#resultText` 规则（第 231-236 行），替换为：

```css
.text-input {
  width: 100%;
  margin: 8px 0 0;
  min-height: 72px;
  max-height: 140px;
  padding: 8px 10px;
  border: 2px solid #d7dbd8;
  border-radius: 8px;
  background: #fffef5;
  font-size: 15px;
  font-family: inherit;
  line-height: 1.6;
  word-break: break-word;
  resize: none;
  overflow-y: auto;
  transition: border-color 0.15s;
  color: inherit;
}

.text-input:focus {
  outline: none;
  border-color: #176b87;
}

.text-input::placeholder {
  color: #9aa6ac;
}
```

- [ ] **Step 2: 添加深色模式样式**

在 `@media (prefers-color-scheme: dark)` 块中（第 877 行 `}` 之前），添加：

```css
  .text-input {
    background: #1e282d;
    border-color: #3b454a;
    color: #f4f4f0;
  }

  .text-input:focus {
    border-color: #176b87;
  }

  .text-input::placeholder {
    color: #6a7a85;
  }
```

- [ ] **Step 3: 在浏览器中确认浅色和深色模式样式正常**

- [ ] **Step 4: Commit**

```bash
git add src/public/style.css
git commit -m "feat(text-input): add textarea styling with dark mode support"
```

---

### Task 3: JS — 发送逻辑与语音追加

**Files:**
- Modify: `src/public/app.js:1-2,471-478,614-624,643-657`

- [ ] **Step 1: 修改元素引用**

将 `app.js` 第 2 行：

```js
const resultEl = document.querySelector("#resultText");
```

替换为：

```js
const textInput = document.querySelector("#textInput");
```

- [ ] **Step 2: 添加键盘发送监听**

在 `app.js` 第 2 行（`textInput` 声明之后）添加：

```js
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTextInput();
  }
});

function sendTextInput() {
  const text = textInput.value.trim();
  if (!text) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg = {
      type: "phrase",
      text,
      autoPaste: autoPasteEl.checked
    };
    if (windowSelector.targetWindow) {
      msg.targetWindow = windowSelector.targetWindow;
    }
    ws.send(JSON.stringify(msg));
    textInput.value = "";
    phrases.hideSaveButton();
    setStatus("已发送到电脑。");
  } else {
    setStatus("发送失败，请检查连接。", true);
  }
}
```

- [ ] **Step 3: 修改收藏按钮逻辑**

将 `app.js` 第 471-478 行：

```js
phrases.el.saveBtn.addEventListener("click", () => {
  const text = resultEl.textContent.trim();
  if (text && text !== "等待录音" && text !== "没有识别到文字") {
    phrases.addPhrase(text);
    phrases.el.saveBtn.textContent = "已收藏 ✓";
    phrases.el.saveBtn.classList.add("saved");
  }
});
```

替换为：

```js
phrases.el.saveBtn.addEventListener("click", () => {
  const text = textInput.value.trim();
  if (text) {
    phrases.addPhrase(text);
    phrases.el.saveBtn.textContent = "已收藏 ✓";
    phrases.el.saveBtn.classList.add("saved");
  }
});
```

- [ ] **Step 4: 修改 uploadAudio 中的结果处理**

将 `app.js` 第 614 行：

```js
    resultEl.textContent = payload.text || "没有识别到文字";
```

替换为：

```js
    appendToTextInput(payload.text || "");
```

- [ ] **Step 5: 修改 WebSocket 消息处理中的结果处理**

将 `app.js` 第 646-648 行：

```js
      if (payload.type === "result" && payload.text) {
        resultEl.textContent = payload.text;
      }
```

替换为：

```js
      if (payload.type === "result" && payload.text) {
        appendToTextInput(payload.text);
        phrases.showSaveButton();
        phrases.el.saveBtn.classList.remove("saved");
        phrases.el.saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> 收藏为常用语';
      }
```

- [ ] **Step 6: 添加 appendToTextInput 函数和收藏按钮显示/隐藏逻辑**

在 `app.js` 中 `sendTextInput` 函数之后添加：

```js
function appendToTextInput(text) {
  if (!text) return;
  const current = textInput.value;
  if (!current.trim()) {
    textInput.value = text;
  } else {
    const lastChar = current.trimEnd().slice(-1);
    const separator = /[，。！？、；：\.\!\?\,\;\:]$/.test(lastChar) ? " " : "";
    textInput.value = current.trimEnd() + separator + text;
  }
  // 滚动到底部
  textInput.scrollTop = textInput.scrollHeight;
}
```

- [ ] **Step 7: 添加 input 事件监听控制收藏按钮显隐**

在 `sendTextInput` 函数之前添加：

```js
textInput.addEventListener("input", () => {
  if (textInput.value.trim()) {
    phrases.showSaveButton();
  } else {
    phrases.hideSaveButton();
  }
});
```

- [ ] **Step 8: 在浏览器中测试完整流程**

测试以下场景：
1. 点击 textarea 输入文字，按回车 → 文字发送到电脑，textarea 清空
2. 语音识别后 → 结果追加到 textarea
3. textarea 有内容时输入文字 → 语音结果追加到末尾
4. 有内容时显示收藏按钮，清空后隐藏
5. 点击收藏按钮 → 文本保存为常用语

- [ ] **Step 9: Commit**

```bash
git add src/public/app.js
git commit -m "feat(text-input): add send-on-enter, voice append, and save button logic"
```

---

### Task 4: 移除 uploadAudio 中的旧收藏按钮逻辑

**Files:**
- Modify: `src/public/app.js:621-623`

- [ ] **Step 1: 删除 uploadAudio 中的重复收藏按钮代码**

删除 `app.js` 第 621-623 行（uploadAudio 成功分支中的收藏按钮显示代码）：

```js
    phrases.showSaveButton();
    phrases.el.saveBtn.classList.remove("saved");
    phrases.el.saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> 收藏为常用语';
```

这段逻辑已在 Task 3 的 WebSocket `result` 消息处理中统一处理，此处属于重复代码。

- [ ] **Step 2: 再次测试语音识别流程，确认收藏按钮仍正常显示**

- [ ] **Step 3: Commit**

```bash
git add src/public/app.js
git commit -m "refactor(text-input): remove duplicate save button logic from uploadAudio"
```
