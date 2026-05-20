# Saved Phrases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a saved phrases feature so users can save frequently-used text and send it to their computer with one tap.

**Architecture:** Frontend PhrasesManager module handles CRUD in localStorage and renders the bottom drawer UI. A new WebSocket message type `phrase` lets the server receive text and call the existing `outputText()` to write clipboard + auto-paste.

**Tech Stack:** Vanilla JS (ES modules), localStorage, WebSocket (ws), existing outputText pipeline

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/public/index.html` | Add drawer DOM, save button, add-phrase dialog |
| `src/public/app.js` | PhrasesManager class, phrase send logic, drawer interaction |
| `src/public/style.css` | Drawer styles, edit mode, save button |
| `src/server/ws.js` | Handle `phrase` WebSocket message, call outputText |

---

### Task 1: Server-side — handle `phrase` WebSocket message

**Files:**
- Modify: `src/server/ws.js`

- [ ] **Step 1: Add outputText import and phrase handler**

At the top of `ws.js`, add `outputText` to the existing import from `./input/paste.js`:

```js
// line 2, change:
import { pressEnter, pressUndo } from "./input/paste.js";
// to:
import { pressEnter, pressUndo } from "./input/paste.js";
import { outputText } from "./input/outputText.js";
```

Inside the `socket.on("message", ...)` handler, after the `undo` block (line 25-26), add a `phrase` handler:

```js
if (payload.type === "phrase" && typeof payload.text === "string") {
  const result = await outputText(payload.text, {
    autoPaste: Boolean(payload.autoPaste)
  });
  broadcast({ type: "output", ...result });
}
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `node --test`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add src/server/ws.js
git commit -m "feat(server): handle phrase WebSocket message for saved phrases"
```

---

### Task 2: Frontend HTML — add drawer and save button DOM

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: Add drawer DOM and save button**

Insert the following HTML after the `action-row` div (after line 40, before `fallbackButton`):

```html
        <div id="phrasesDrawer" class="phrases-drawer">
          <button id="phrasesToggle" class="phrases-toggle" type="button">
            <span id="phrasesToggleIcon">▶</span>
            常用语 <span id="phrasesCount">(0)</span>
          </button>
          <div id="phrasesPanel" class="phrases-panel hidden">
            <div class="phrases-header">
              <span>常用语 <span id="phrasesPanelCount">(0)</span></span>
              <div class="phrases-header-actions">
                <button id="phrasesAddBtn" class="phrases-add-btn" type="button">+ 新增</button>
                <button id="phrasesEditDoneBtn" class="phrases-edit-done-btn hidden" type="button">完成</button>
              </div>
            </div>
            <ul id="phrasesList" class="phrases-list"></ul>
          </div>
        </div>
```

Insert a save button inside the `.result` section, after the `#resultText` paragraph (after line 49):

```html
          <button id="savePhraseBtn" class="save-phrase-btn hidden" type="button">
            <svg viewBox="0 0 24 24" width="16" height="16"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            收藏为常用语
          </button>
```

Add an "add phrase" dialog at the end of `<body>`, before the `<script>` tag:

```html
    <div id="addPhraseDialog" class="add-phrase-dialog hidden">
      <div class="add-phrase-overlay"></div>
      <div class="add-phrase-content">
        <h3>新增常用语</h3>
        <textarea id="addPhraseInput" class="add-phrase-input" rows="3" placeholder="输入常用语内容…"></textarea>
        <div class="add-phrase-actions">
          <button id="addPhraseCancelBtn" class="add-phrase-cancel-btn" type="button">取消</button>
          <button id="addPhraseConfirmBtn" class="add-phrase-confirm-btn" type="button">保存</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: Commit**

```bash
git add src/public/index.html
git commit -m "feat(client): add saved phrases drawer and dialog DOM"
```

---

### Task 3: Frontend CSS — drawer and phrase styles

**Files:**
- Modify: `src/public/style.css`

- [ ] **Step 1: Add phrase drawer styles**

Append these styles before the `@media (prefers-color-scheme: dark)` block (before line 238):

```css
/* Phrases drawer */
.phrases-drawer {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.phrases-toggle {
  width: 100%;
  min-height: 36px;
  border: 0;
  border-radius: 6px;
  background: #e8e8e4;
  color: #52616b;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  touch-action: manipulation;
}

.phrases-toggle #phrasesToggleIcon {
  font-size: 10px;
  transition: transform 0.2s;
}

.phrases-drawer.open .phrases-toggle #phrasesToggleIcon {
  transform: rotate(90deg);
}

.phrases-panel {
  margin-top: 6px;
  border: 1px solid #d7dbd8;
  border-radius: 8px;
  overflow: hidden;
}

.phrases-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: #f0f0ec;
  font-size: 12px;
  font-weight: 600;
  color: #52616b;
}

.phrases-header-actions {
  display: flex;
  gap: 8px;
}

.phrases-add-btn {
  border: 0;
  background: none;
  color: #176b87;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

.phrases-edit-done-btn {
  border: 0;
  background: none;
  color: #176b87;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

.phrases-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 150px;
  overflow-y: auto;
}

.phrases-list:empty::after {
  content: "暂无常用语，点击"+ 新增"添加";
  display: block;
  padding: 16px 10px;
  text-align: center;
  color: #9aa6ac;
  font-size: 12px;
}

.phrases-item {
  padding: 8px 10px;
  border-bottom: 1px solid #eee;
  font-size: 13px;
  color: #29343a;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
  display: flex;
  align-items: center;
  gap: 8px;
}

.phrases-item:last-child {
  border-bottom: none;
}

.phrases-item:active {
  background: #e0e7ee;
}

.phrases-item.editing {
  cursor: default;
  background: #fffde8;
  border-left: 3px solid #eab308;
}

.phrases-item-text {
  flex: 1;
  word-break: break-word;
  line-height: 1.4;
}

.phrases-item-edit-input {
  flex: 1;
  border: 1px solid #ccc;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
  resize: none;
}

.phrases-item-delete {
  border: 0;
  background: none;
  color: #dc2626;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  white-space: nowrap;
  border-radius: 4px;
}

.phrases-item-delete:hover {
  background: #fecaca;
}

/* Save phrase button */
.save-phrase-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 36px;
  margin-top: 8px;
  border: 0;
  border-radius: 6px;
  background: #176b87;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
}

.save-phrase-btn svg {
  flex-shrink: 0;
}

.save-phrase-btn.saved {
  background: #78716c;
  pointer-events: none;
}

/* Add phrase dialog */
.add-phrase-dialog {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.add-phrase-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
}

.add-phrase-content {
  position: relative;
  width: 100%;
  max-width: 420px;
  background: #fff;
  border-radius: 12px 12px 0 0;
  padding: 20px;
  z-index: 1;
}

.add-phrase-content h3 {
  margin: 0 0 12px;
  font-size: 17px;
}

.add-phrase-input {
  width: 100%;
  border: 1px solid #d7dbd8;
  border-radius: 6px;
  padding: 10px;
  font-size: 14px;
  font-family: inherit;
  resize: none;
  line-height: 1.5;
}

.add-phrase-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.add-phrase-cancel-btn {
  flex: 1;
  min-height: 40px;
  border: 1px solid #d7dbd8;
  border-radius: 6px;
  background: #fff;
  color: #52616b;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.add-phrase-confirm-btn {
  flex: 1;
  min-height: 40px;
  border: 0;
  border-radius: 6px;
  background: #176b87;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.add-phrase-confirm-btn:disabled {
  background: #7b8790;
  cursor: not-allowed;
}
```

- [ ] **Step 2: Add dark mode overrides**

Append inside the existing `@media (prefers-color-scheme: dark)` block (before its closing `}`):

```css
  .phrases-toggle {
    background: #2b353a;
    color: #b5c0c7;
  }

  .phrases-panel {
    border-color: #2b353a;
  }

  .phrases-header {
    background: #1e282d;
    color: #b5c0c7;
  }

  .phrases-item {
    color: #f4f4f0;
    border-bottom-color: #2b353a;
  }

  .phrases-item:active {
    background: #2b353a;
  }

  .phrases-item.editing {
    background: #2a2510;
    border-left-color: #eab308;
  }

  .phrases-item-edit-input {
    background: #1e282d;
    border-color: #3b454a;
    color: #f4f4f0;
  }

  .phrases-item-delete:hover {
    background: #3b1515;
  }

  .add-phrase-content {
    background: #1a2025;
  }

  .add-phrase-content h3 {
    color: #f4f4f0;
  }

  .add-phrase-input {
    background: #2b353a;
    border-color: #3b454a;
    color: #f4f4f0;
  }

  .add-phrase-cancel-btn {
    background: #2b353a;
    border-color: #3b454a;
    color: #b5c0c7;
  }
```

- [ ] **Step 3: Commit**

```bash
git add src/public/style.css
git commit -m "feat(client): add saved phrases drawer and dialog styles"
```

---

### Task 4: Frontend JS — PhrasesManager class

**Files:**
- Modify: `src/public/app.js`

- [ ] **Step 1: Add PhrasesManager class**

Insert the following class at the top of `app.js`, after the DOM element constants (after line 8), before the `iconEl` line:

```js
class PhrasesManager {
  static STORAGE_KEY = "voicebridge_phrases";

  constructor() {
    this.el = {
      drawer: document.querySelector("#phrasesDrawer"),
      toggle: document.querySelector("#phrasesToggle"),
      panel: document.querySelector("#phrasesPanel"),
      list: document.querySelector("#phrasesList"),
      count: document.querySelector("#phrasesCount"),
      panelCount: document.querySelector("#phrasesPanelCount"),
      addBtn: document.querySelector("#phrasesAddBtn"),
      editDoneBtn: document.querySelector("#phrasesEditDoneBtn"),
      saveBtn: document.querySelector("#savePhraseBtn"),
      dialog: document.querySelector("#addPhraseDialog"),
      dialogOverlay: document.querySelector(".add-phrase-overlay"),
      dialogInput: document.querySelector("#addPhraseInput"),
      dialogCancel: document.querySelector("#addPhraseCancelBtn"),
      dialogConfirm: document.querySelector("#addPhraseConfirmBtn"),
    };
    this.editingId = null;
    this._init();
  }

  _init() {
    this.el.toggle.addEventListener("click", () => this._toggle());
    this.el.addBtn.addEventListener("click", () => this._openAddDialog());
    this.el.dialogCancel.addEventListener("click", () => this._closeDialog());
    this.el.dialogOverlay.addEventListener("click", () => this._closeDialog());
    this.el.dialogConfirm.addEventListener("click", () => this._confirmAdd());
    this.el.editDoneBtn.addEventListener("click", () => this._exitEditMode());
    this._render();
  }

  get _phrases() {
    try {
      return JSON.parse(localStorage.getItem(PhrasesManager.STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  }

  set _phrases(arr) {
    localStorage.setItem(PhrasesManager.STORAGE_KEY, JSON.stringify(arr));
  }

  _updateCounts() {
    const n = this._phrases.length;
    this.el.count.textContent = `(${n})`;
    this.el.panelCount.textContent = `(${n})`;
  }

  _toggle() {
    this.el.drawer.classList.toggle("open");
    this.el.panel.classList.toggle("hidden");
    if (this.el.drawer.classList.contains("open")) {
      this._exitEditMode();
    }
  }

  _render() {
    const phrases = this._phrases;
    this._updateCounts();
    this.el.list.innerHTML = "";

    phrases.forEach((phrase) => {
      const li = document.createElement("li");
      li.className = "phrases-item";
      li.dataset.id = phrase.id;

      const textSpan = document.createElement("span");
      textSpan.className = "phrases-item-text";
      textSpan.textContent = phrase.text;
      li.appendChild(textSpan);

      li.addEventListener("click", (e) => {
        if (this.editingId) return;
        this._sendPhrase(phrase.text);
      });

      let longPressTimer;
      li.addEventListener("pointerdown", () => {
        longPressTimer = setTimeout(() => {
          this._enterEditMode(phrase.id);
          longPressTimer = null;
        }, 500);
      });
      li.addEventListener("pointerup", () => {
        if (longPressTimer) clearTimeout(longPressTimer);
      });
      li.addEventListener("pointerleave", () => {
        if (longPressTimer) clearTimeout(longPressTimer);
      });

      this.el.list.appendChild(li);
    });
  }

  _sendPhrase(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "phrase",
        text,
        autoPaste: autoPasteEl.checked
      }));
      setStatus(`已发送常用语到电脑。`);
    } else {
      setStatus("发送失败，请检查连接。", true);
    }
  }

  _enterEditMode(editId) {
    this.editingId = editId;
    this.el.addBtn.classList.add("hidden");
    this.el.editDoneBtn.classList.remove("hidden");

    const items = this.el.list.querySelectorAll(".phrases-item");
    items.forEach((li) => {
      const id = li.dataset.id;
      const textSpan = li.querySelector(".phrases-item-text");
      const phrase = this._phrases.find((p) => p.id === id);
      if (!phrase) return;

      if (id === editId) {
        li.classList.add("editing");
        textSpan.classList.add("hidden");
        const input = document.createElement("textarea");
        input.className = "phrases-item-edit-input";
        input.rows = 2;
        input.value = phrase.text;
        li.insertBefore(input, textSpan.nextSibling);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "phrases-item-delete";
        deleteBtn.type = "button";
        deleteBtn.textContent = "删除";
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this._deletePhrase(id);
        });
        li.appendChild(deleteBtn);
      } else {
        li.style.opacity = "0.4";
        li.style.pointerEvents = "none";
      }
    });
  }

  _exitEditMode() {
    this.editingId = null;
    this.el.addBtn.classList.remove("hidden");
    this.el.editDoneBtn.classList.add("hidden");
    this._saveEditChanges();
    this._render();
  }

  _saveEditChanges() {
    const phrases = this._phrases;
    const editedInput = this.el.list.querySelector(
      ".phrases-item.editing .phrases-item-edit-input"
    );
    if (!editedInput) return;

    const editedId = editedInput.closest(".phrases-item").dataset.id;
    const newText = editedInput.value.trim();
    if (!newText) {
      this._deletePhrase(editedId);
      return;
    }
    const phrase = phrases.find((p) => p.id === editedId);
    if (phrase) {
      phrase.text = newText;
      this._phrases = phrases;
    }
  }

  _deletePhrase(id) {
    const phrases = this._phrases.filter((p) => p.id !== id);
    this._phrases = phrases;
    this._render();
  }

  _openAddDialog() {
    this.el.dialogInput.value = "";
    this.el.dialog.classList.remove("hidden");
    this.el.dialogInput.focus();
  }

  _closeDialog() {
    this.el.dialog.classList.add("hidden");
  }

  _confirmAdd() {
    const text = this.el.dialogInput.value.trim();
    if (!text) return;
    const phrases = this._phrases;
    phrases.unshift({
      id: crypto.randomUUID(),
      text,
      createdAt: Date.now()
    });
    this._phrases = phrases;
    this._render();
    this._closeDialog();
  }

  addPhrase(text) {
    const exists = this._phrases.some((p) => p.text === text);
    if (exists) {
      setStatus("该常用语已存在。");
      return;
    }
    const phrases = this._phrases;
    phrases.unshift({
      id: crypto.randomUUID(),
      text,
      createdAt: Date.now()
    });
    this._phrases = phrases;
    this._render();
    setStatus("已收藏为常用语。");
  }

  showSaveButton() {
    this.el.saveBtn.classList.remove("hidden");
  }

  hideSaveButton() {
    this.el.saveBtn.classList.add("hidden");
  }
}
```

- [ ] **Step 2: Instantiate PhrasesManager and wire save button**

After the `const subEl = recordButton.querySelector(".record-sub");` line (line 12), add:

```js
const phrases = new PhrasesManager();
```

After the `undoButton` event listener block (after line 44), add:

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

- [ ] **Step 3: Show save button after successful recognition**

In the `uploadAudio` function, after the status update block (after line 181, before the `catch`), add:

```js
    phrases.showSaveButton();
    phrases.el.saveBtn.classList.remove("saved");
    phrases.el.saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> 收藏为常用语';
```

- [ ] **Step 4: Commit**

```bash
git add src/public/app.js
git commit -m "feat(client): implement PhrasesManager with drawer, CRUD, and send"
```

---

### Task 5: Manual smoke test

- [ ] **Step 1: Start the server and verify**

Run: `node src/server/index.js`

On mobile browser (via QR code):
1. Verify the "▶ 常用语 (0)" drawer appears below the action row
2. Click to expand — should show "暂无常用语" placeholder
3. Click "+ 新增" — dialog should appear
4. Type text, click "保存" — phrase appears in list
5. Click phrase — should show "已发送常用语到电脑" and text appears in computer clipboard
6. Long-press phrase — enters edit mode, can edit text or delete
7. Record voice, get result — "收藏为常用语" button appears
8. Click save button — phrase saved, button changes to "已收藏 ✓"
9. Toggle auto-paste off, send a phrase — text copied but not pasted
10. Refresh page — phrases persist (localStorage)

- [ ] **Step 2: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(client): smoke test fixes for saved phrases"
```
