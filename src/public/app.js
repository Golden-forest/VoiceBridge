// === Element References ===
const statusDot = document.querySelector("#statusDot");
const statusBadge = document.querySelector("#statusBadge");
const textInput = document.querySelector("#textInput");
const charCount = document.querySelector("#charCount");
const autoPasteEl = document.querySelector("#autoPaste");
const toastEl = document.querySelector("#toast");
const pageRefreshButton = document.querySelector("#pageRefreshButton");

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

// === Toast ===
let toastTimer = null;

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.toggle("error", isError);
  toastEl.classList.add("show");
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

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

// === Status Dot ===
function setConnectionStatus(state, message) {
  statusDot.className = "status-dot " + state;
  statusDot.title = message;
  if (!statusBadge) return;
  const labels = {
    connected: "已连接",
    error: "未连接",
    connecting: "连接中"
  };
  statusBadge.className = "status-badge " + state;
  statusBadge.textContent = labels[state] || "连接中";
}

statusDot.addEventListener("click", () => {
  showToast(statusDot.title);
});

pageRefreshButton?.addEventListener("click", () => {
  location.reload();
});

// === Text Input ===
function updateTextInputState() {
  const text = textInput.value.trim();
  if (charCount) charCount.textContent = `${textInput.value.length}/2000`;
  if (text) {
    phrases.showSaveButton();
    phrases.el.saveBtn.classList.remove("saved");
    phrases.el.saveBtn.innerHTML = starSvg + " 收藏";
  } else {
    phrases.hideSaveButton();
  }
}

let lastAutoPastedText = "";

function sendTextInput() {
  const text = textInput.value.trim();
  if (!text) return;
  if (text === lastAutoPastedText) {
    textInput.value = "";
    updateTextInputState();
    lastAutoPastedText = "";
    showToast("该文本已通过语音自动发送。");
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg = {
      type: "phrase",
      text,
      autoPaste: autoPasteEl.checked
    };
    if (windowSelector.targetWindow) {
      msg.targetWindow = windowSelector.targetWindow;
    }
    copyToPhoneClipboard(text);
    ws.send(JSON.stringify(msg));
    textInput.value = "";
    updateTextInputState();
    lastAutoPastedText = "";
    showToast("已发送到电脑。");
  } else {
    showToast("发送失败，请检查连接。", true);
  }
}

// === SVG Icons ===
const starSvg = '<svg viewBox="0 0 24 24" width="14" height="14"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// === Record Button ===
const recordButton = document.querySelector("#recordButton");
const submitButton = document.querySelector("#submitButton");
const enterButton = document.querySelector("#enterButton");
const fallbackButton = document.querySelector("#fallbackButton");
const fallbackFile = document.querySelector("#fallbackFile");

const iconEl = recordButton.querySelector(".record-icon");
const labelEl = recordButton.querySelector(".record-label");

// === WindowSelector (unchanged) ===
class WindowSelector {
  static STORAGE_KEY = "voicebridge_selected_window";

  constructor() {
    this.el = {
      btn: document.querySelector("#windowBtn"),
      btnLabel: document.querySelector("#windowBtnLabel"),
      dropdown: document.querySelector("#windowDropdown"),
      list: document.querySelector("#windowList"),
      refreshBtn: document.querySelector("#windowRefreshBtn")
    };
    this.selectedWindow = this._loadSelection();
    this._isOpen = false;
    this._init();
  }

  _init() {
    this.el.btn.addEventListener("click", (e) => { e.stopPropagation(); this._toggle(); });
    this.el.refreshBtn.addEventListener("click", (e) => { e.stopPropagation(); this._fetchWindows(); });
    document.addEventListener("click", (e) => {
      if (this._isOpen && !this.el.dropdown.contains(e.target)) this._close();
    });
    this._updateButton();
  }

  get targetWindow() { return this.selectedWindow; }

  _loadSelection() { try { return JSON.parse(localStorage.getItem(WindowSelector.STORAGE_KEY)); } catch { return null; } }
  _saveSelection() {
    if (this.selectedWindow) localStorage.setItem(WindowSelector.STORAGE_KEY, JSON.stringify(this.selectedWindow));
    else localStorage.removeItem(WindowSelector.STORAGE_KEY);
  }

  _toggle() { this._isOpen ? this._close() : this._open(); }
  _open() { this._isOpen = true; this.el.dropdown.classList.remove("hidden"); this._fetchWindows(); }
  _close() { this._isOpen = false; this.el.dropdown.classList.add("hidden"); }

  _updateButton() {
    if (this.selectedWindow) {
      this.el.btnLabel.textContent = this.selectedWindow.appName;
      this.el.btn.classList.add("active");
    } else {
      this.el.btnLabel.textContent = "光标位置";
      this.el.btn.classList.remove("active");
    }
  }

  async _fetchWindows() {
    this.el.list.innerHTML = '<p class="window-list-loading">加载中…</p>';
    try {
      const res = await fetch("/api/windows");
      const data = await res.json();
      if (!data.ok || !data.windows || data.windows.length === 0) {
        this.el.list.innerHTML = '<p class="window-list-empty">没有找到可输入的窗口</p>';
        return;
      }
      this._renderWindows(data.windows);
    } catch {
      this.el.list.innerHTML = '<p class="window-list-empty">获取窗口失败</p>';
    }
  }

  _renderWindows(groups) {
    this.el.list.innerHTML = "";
    groups.forEach((group) => {
      const groupEl = document.createElement("div");
      groupEl.className = "window-app-group";
      const label = document.createElement("div");
      label.className = "window-app-label";
      label.textContent = group.appName;
      groupEl.appendChild(label);
      group.windows.forEach((win) => {
        const btn = document.createElement("button");
        btn.className = "window-item";
        btn.type = "button";
        const isSelected = this.selectedWindow && this.selectedWindow.appName === group.appName && this.selectedWindow.windowTitle === win.title;
        if (isSelected) btn.classList.add("selected");
        const check = document.createElement("span");
        check.className = "window-item-check";
        check.textContent = isSelected ? "✓" : "";
        btn.appendChild(check);
        const title = document.createElement("span");
        title.className = "window-item-title";
        title.textContent = win.title;
        btn.appendChild(title);
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (isSelected) this.selectedWindow = null;
          else this.selectedWindow = { appName: group.appName, windowTitle: win.title };
          this._saveSelection();
          this._updateButton();
          this._close();
        });
        groupEl.appendChild(btn);
      });
      this.el.list.appendChild(groupEl);
    });
  }
}

// === RecentCommands ===
class RecentCommands {
  static STORAGE_KEY = "voicebridge_recent_commands";
  static MAX_ITEMS = 12;
  static MAX_LABEL_LEN = 8;

  constructor(containerEl) {
    this.container = containerEl;
    this._commands = this._load();
    this._render();
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(RecentCommands.STORAGE_KEY)) || []; } catch { return []; }
  }

  _save() {
    localStorage.setItem(RecentCommands.STORAGE_KEY, JSON.stringify(this._commands));
  }

  record(text, label) {
    const entry = { text, label, ts: Date.now() };
    this._commands = this._commands.filter((c) => c.text !== text);
    this._commands.unshift(entry);
    this._commands = this._commands.slice(0, RecentCommands.MAX_ITEMS);
    this._save();
    this._render();
  }

  _truncate(str) {
    if (str.length <= RecentCommands.MAX_LABEL_LEN) return str;
    return str.slice(0, RecentCommands.MAX_LABEL_LEN) + "…";
  }

  _render() {
    this.container.innerHTML = "";
    if (this._commands.length === 0) {
      this.container.classList.add("hidden");
      return;
    }
    this.container.classList.remove("hidden");
    this._commands.forEach((cmd) => {
      const btn = document.createElement("button");
      btn.className = "recent-tag";
      btn.type = "button";
      btn.dataset.text = cmd.text;
      btn.textContent = this._truncate(cmd.label);
      btn.title = cmd.text;
      this.container.appendChild(btn);
    });
  }
}

// === PhrasesManager (unchanged) ===
class PhrasesManager {
  static STORAGE_KEY = "voicebridge_phrases";

  constructor() {
    this.el = {
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
    this.el.addBtn.addEventListener("click", () => this._openAddDialog());
    this.el.dialogCancel.addEventListener("click", () => this._closeDialog());
    this.el.dialogOverlay.addEventListener("click", () => this._closeDialog());
    this.el.dialogConfirm.addEventListener("click", () => this._confirmAdd());
    this.el.editDoneBtn.addEventListener("click", () => this._exitEditMode());
    this._render();
  }

  get _phrases() { try { return JSON.parse(localStorage.getItem(PhrasesManager.STORAGE_KEY)) || []; } catch { return []; } }
  set _phrases(arr) { localStorage.setItem(PhrasesManager.STORAGE_KEY, JSON.stringify(arr)); }

  _updateCounts() {
    const n = this._phrases.length;
    this.el.count.textContent = `(${n})`;
    this.el.panelCount.textContent = `(${n})`;
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
      li.addEventListener("click", () => { if (!this.editingId) this._sendPhrase(phrase.text); });
      let longPressTimer;
      li.addEventListener("pointerdown", () => { longPressTimer = setTimeout(() => { this._enterEditMode(phrase.id); longPressTimer = null; }, 500); });
      li.addEventListener("pointerup", () => { if (longPressTimer) clearTimeout(longPressTimer); });
      li.addEventListener("pointerleave", () => { if (longPressTimer) clearTimeout(longPressTimer); });
      this.el.list.appendChild(li);
    });
  }

  _sendPhrase(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg = { type: "phrase", text, autoPaste: autoPasteEl.checked };
      if (windowSelector.targetWindow) msg.targetWindow = windowSelector.targetWindow;
      copyToPhoneClipboard(text);
      ws.send(JSON.stringify(msg));
      showToast("已发送常用语到电脑。");
    } else {
      showToast("发送失败，请检查连接。", true);
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
        deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); this._deletePhrase(id); });
        li.appendChild(deleteBtn);
      } else {
        li.style.opacity = "0.4";
        li.style.pointerEvents = "none";
      }
    });
  }

  _exitEditMode() {
    if (!this.editingId) return;
    this.editingId = null;
    this.el.addBtn.classList.remove("hidden");
    this.el.editDoneBtn.classList.add("hidden");
    this._saveEditChanges();
    this._render();
  }

  _saveEditChanges() {
    const editedInput = this.el.list.querySelector(".phrases-item.editing .phrases-item-edit-input");
    if (!editedInput) return;
    const editedId = editedInput.closest(".phrases-item").dataset.id;
    const newText = editedInput.value.trim();
    if (!newText) { this._deletePhrase(editedId); return; }
    const phrase = this._phrases.find((p) => p.id === editedId);
    if (phrase) { phrase.text = newText; this._phrases = this._phrases; }
  }

  _deletePhrase(id) { this._phrases = this._phrases.filter((p) => p.id !== id); this._render(); }

  _openAddDialog() { this.el.dialogInput.value = ""; this.el.dialog.classList.remove("hidden"); this.el.dialogInput.focus(); }
  _closeDialog() { this.el.dialog.classList.add("hidden"); }

  _confirmAdd() {
    const text = this.el.dialogInput.value.trim();
    if (!text) return;
    const phrases = this._phrases;
    phrases.unshift({ id: crypto.randomUUID(), text, createdAt: Date.now() });
    this._phrases = phrases;
    this._render();
    this._closeDialog();
  }

  addPhrase(text) {
    const exists = this._phrases.some((p) => p.text === text);
    if (exists) { showToast("该常用语已存在。"); return; }
    const phrases = this._phrases;
    phrases.unshift({ id: crypto.randomUUID(), text, createdAt: Date.now() });
    this._phrases = phrases;
    this._render();
    showToast("已收藏为常用语。");
  }

  showSaveButton() { this.el.saveBtn.classList.remove("hidden"); }
  hideSaveButton() { this.el.saveBtn.classList.add("hidden"); }
}

// === CommandLibrary ===
class CommandLibrary {
  constructor(containerEl) {
    this.container = containerEl;
    this.commands = [];
    this.filter = "";
    this.editingId = null;
    this.collapsedCategories = new Set();
    this._longPressTimer = null;
    this._longPressTriggered = false;
    this._bindContainerEvents();
    this.load();
  }

  _bindContainerEvents() {
    this.container.addEventListener("click", (e) => {
      // Category header toggle
      const header = e.target.closest(".category-header");
      if (header) {
        const cat = header.dataset.category;
        this.toggleCategory(cat);
        return;
      }
      // Command button click
      const btn = e.target.closest(".cmd-btn");
      if (!btn) return;
      const id = btn.dataset.id;
      if (this.editingId) {
        if (btn.classList.contains("cmd-delete-btn")) {
          this._deleteCommand(id);
        } else if (btn.classList.contains("cmd-done-btn")) {
          this._exitEditMode();
        }
        return;
      }
      const cmd = this.commands.find(c => c.id === id);
      if (!cmd) return;
      sendQuickCommand(cmd.text, cmd.label);
      this.touchCommand(id);
    });
    // Long press for edit mode
    this.container.addEventListener("pointerdown", (e) => {
      const btn = e.target.closest(".cmd-btn");
      if (!btn || this.editingId) return;
      const id = btn.dataset.id;
      this._longPressTriggered = false;
      this._longPressTimer = setTimeout(() => {
        this._longPressTriggered = true;
        this._enterEditMode(id);
      }, 500);
    });
    this.container.addEventListener("pointerup", () => { clearTimeout(this._longPressTimer); });
    this.container.addEventListener("pointerleave", () => { clearTimeout(this._longPressTimer); });
    this.container.addEventListener("pointermove", (e) => {
      if (this._longPressTimer) clearTimeout(this._longPressTimer);
    });
  }

  async load() {
    try {
      const res = await fetch("/api/commands");
      this.commands = await res.json();
      this.render();
    } catch {
      this.container.innerHTML = '<p style="padding:12px;color:var(--text-muted);text-align:center;">加载指令失败</p>';
    }
  }

  _getCategories() {
    const map = {};
    this.commands.forEach(cmd => {
      const cat = cmd.category || "未分类";
      if (!map[cat]) map[cat] = [];
      map[cat].push(cmd);
    });
    // Sort each category's commands by lastUsedAt (most recent first)
    Object.values(map).forEach(cmds => {
      cmds.sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0));
    });
    // Sort categories by most recent lastUsedAt across all commands
    const sorted = Object.entries(map).sort((a, b) => {
      const aMax = Math.max(...a[1].map(c => new Date(c.lastUsedAt || 0)));
      const bMax = Math.max(...b[1].map(c => new Date(c.lastUsedAt || 0)));
      return bMax - aMax;
    });
    return sorted;
  }

  render(filter) {
    this.filter = filter || this.filter;
    const cats = this._getCategories();
    const q = this.filter.toLowerCase();
    this.container.innerHTML = "";

    if (cats.length === 0) {
      this.container.innerHTML = '<p style="padding:12px;color:var(--text-muted);text-align:center;">暂无指令</p>';
      return;
    }

    let hasVisible = false;
    cats.forEach(([category, cmds]) => {
      const filtered = q
        ? cmds.filter(c => (c.label || "").toLowerCase().includes(q) || (c.text || "").toLowerCase().includes(q))
        : cmds;
      if (filtered.length === 0) return;
      hasVisible = true;

      const group = document.createElement("div");
      group.className = "category-group";

      const isCollapsed = this.collapsedCategories.has(category);

      const header = document.createElement("div");
      header.className = "category-header";
      header.dataset.category = category;
      header.innerHTML = `
        <div class="category-left">
          <span class="category-arrow${isCollapsed ? "" : " open"}">&#x25BE;</span>
          <span class="category-name">${this._escHtml(category)}</span>
          <span class="category-count">${filtered.length}</span>
        </div>
      `;
      group.appendChild(header);

      if (!isCollapsed) {
        const grid = document.createElement("div");
        grid.className = "cmd-grid";
        filtered.forEach(cmd => {
          const btn = document.createElement("button");
          btn.className = "cmd-btn";
          btn.type = "button";
          btn.dataset.id = cmd.id;
          btn.title = cmd.text;
          if (this.editingId === cmd.id) {
            btn.classList.add("editing");
            const input = document.createElement("span");
            input.className = "cmd-edit-label";
            input.contentEditable = "true";
            input.textContent = cmd.label;
            btn.appendChild(input);
            // Delete and Done buttons
            const actions = document.createElement("span");
            actions.className = "cmd-edit-actions";
            const delBtn = document.createElement("span");
            delBtn.className = "cmd-btn cmd-delete-btn";
            delBtn.dataset.id = cmd.id;
            delBtn.textContent = "删除";
            actions.appendChild(delBtn);
            const doneBtn = document.createElement("span");
            doneBtn.className = "cmd-btn cmd-done-btn";
            doneBtn.textContent = "完成";
            actions.appendChild(doneBtn);
            btn.appendChild(actions);
            // Stop event propagation on inner buttons
            delBtn.addEventListener("pointerdown", e => e.stopPropagation());
            doneBtn.addEventListener("pointerdown", e => e.stopPropagation());
          } else {
            if (this.editingId) btn.classList.add("dimmed");
            const labelSpan = document.createElement("span");
            labelSpan.className = "cmd-label";
            labelSpan.textContent = cmd.label;
            btn.appendChild(labelSpan);
          }
          grid.appendChild(btn);
        });
        group.appendChild(grid);
      }

      this.container.appendChild(group);
    });

    if (!hasVisible) {
      this.container.innerHTML = '<p style="padding:12px;color:var(--text-muted);text-align:center;">没有匹配的指令</p>';
    }
  }

  toggleCategory(category) {
    if (this.collapsedCategories.has(category)) {
      this.collapsedCategories.delete(category);
    } else {
      this.collapsedCategories.add(category);
    }
    this.render();
  }

  _enterEditMode(id) {
    this.editingId = id;
    this.render();
  }

  _exitEditMode() {
    if (!this.editingId) return;
    // Save label changes
    const editInput = this.container.querySelector(`.cmd-btn.editing .cmd-edit-label`);
    if (editInput) {
      const newLabel = editInput.textContent.trim();
      if (newLabel) {
        this._updateCommand(this.editingId, { label: newLabel });
      }
    }
    this.editingId = null;
    this.render();
  }

  async _deleteCommand(id) {
    try {
      await fetch(`/api/commands/${id}`, { method: "DELETE" });
      this.commands = this.commands.filter(c => c.id !== id);
      this.editingId = null;
      showToast("已删除指令。");
      this.render();
    } catch {
      showToast("删除失败。", true);
    }
  }

  async _updateCommand(id, updates) {
    try {
      const res = await fetch(`/api/commands/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates)
      });
      const updated = await res.json();
      const idx = this.commands.findIndex(c => c.id === id);
      if (idx !== -1) this.commands[idx] = updated;
    } catch {
      // silently fail, stale data will refresh on next load
    }
  }

  async touchCommand(id) {
    try {
      const res = await fetch(`/api/commands/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastUsedAt: new Date().toISOString() })
      });
      const updated = await res.json();
      const idx = this.commands.findIndex(c => c.id === id);
      if (idx !== -1) this.commands[idx] = updated;
      this.render();
    } catch {
      // silently fail
    }
  }

  async addCommand(text, category) {
    try {
      const res = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          label: text.length > 8 ? text.slice(0, 8) + "\u2026" : text,
          category: category || "通用"
        })
      });
      const created = await res.json();
      this.commands.unshift(created);
      this.render();
      showToast("已添加指令。");
    } catch {
      showToast("添加失败。", true);
    }
  }

  getUniqueCategories() {
    return new Set(this.commands.map(c => c.category || "未分类"));
  }

  openAddDialog(preText) {
    const dialog = document.getElementById("addCommandDialog");
    const input = document.getElementById("addCommandInput");
    const select = document.getElementById("addCommandCategory");
    const newCatInput = document.getElementById("addCommandNewCategory");
    if (preText) input.value = preText;
    else input.value = "";
    newCatInput.value = "";
    // Populate category select
    select.innerHTML = "";
    this.getUniqueCategories().forEach(cat => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      select.appendChild(opt);
    });
    // Add "新分类..." option
    const newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "新分类…";
    select.appendChild(newOpt);
    select.value = select.options[0].value;
    newCatInput.classList.add("hidden");
    dialog.classList.remove("hidden");
    input.focus();
  }

  closeAddDialog() {
    document.getElementById("addCommandDialog").classList.add("hidden");
  }

  async confirmAdd() {
    const input = document.getElementById("addCommandInput");
    const select = document.getElementById("addCommandCategory");
    const newCatInput = document.getElementById("addCommandNewCategory");
    const text = input.value.trim();
    if (!text) return;
    const category = select.value === "__new__"
      ? (newCatInput.value.trim() || "通用")
      : select.value;
    await this.addCommand(text, category);
    this.closeAddDialog();
  }

  _escHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }
}

// === Initialize ===
const phrases = new PhrasesManager();
const windowSelector = new WindowSelector();
const recentCommands = new RecentCommands(document.querySelector("#recentBar"));

// === Text Input Events ===
updateTextInputState();

textInput.addEventListener("input", () => {
  lastAutoPastedText = "";
  updateTextInputState();
});

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextInput(); }
});

// === Tab Navigation ===
const tabQuick = document.querySelector("#tabQuick");
const tabPhrases = document.querySelector("#tabPhrases");
const quickPanel = document.querySelector("#quickPanel");
const phrasesPanel = document.querySelector("#phrasesPanel");

tabQuick.addEventListener("click", () => {
  tabQuick.classList.add("active");
  tabPhrases.classList.remove("active");
  quickPanel.classList.remove("hidden");
  phrasesPanel.classList.add("hidden");
});

tabPhrases.addEventListener("click", () => {
  tabPhrases.classList.add("active");
  tabQuick.classList.remove("active");
  phrasesPanel.classList.remove("hidden");
  quickPanel.classList.add("hidden");
});

// === Paste & Undo Buttons ===
const pasteButton = document.querySelector("#pasteButton");
const undoButton = document.querySelector("#undoButton");

pasteButton.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "paste" }));
    showToast("已粘贴。");
  } else {
    showToast("发送失败，请检查连接。", true);
  }
});

undoButton.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "undo" }));
    showToast("已撤销。");
  } else {
    showToast("发送失败，请检查连接。", true);
  }
});

// Recent bar click
document.querySelector("#recentBar").addEventListener("click", (e) => {
  const tag = e.target.closest(".recent-tag");
  if (!tag) return;
  const text = tag.dataset.text;
  if (!text) return;
  sendQuickCommand(text, tag.textContent);
});

function sendQuickCommand(text, label) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg = { type: "phrase", text, autoPaste: autoPasteEl.checked };
    if (windowSelector.targetWindow) msg.targetWindow = windowSelector.targetWindow;
    copyToPhoneClipboard(text);
    ws.send(JSON.stringify(msg));
    recentCommands.record(text, label || text);
    showToast("已发送快捷指令。");
  } else {
    showToast("发送失败，请检查连接。", true);
  }
}

// === Action Buttons ===
submitButton.addEventListener("click", () => {
  sendTextInput();
});

enterButton.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "enter" }));
    showToast("已按回车。");
  } else {
    showToast("发送失败，请检查连接。", true);
  }
});

// Capsule phrase buttons (exit, /compact, npm start, copyclaw cli/server)
const shortcutIcons = {
  exit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17 15 12l-5-5"/><path d="M15 12H3"/><path d="M14 4h5v16h-5"/></svg>',
  compact: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 3 4 4-4 4"/><path d="M12 7H3"/><path d="m16 21-4-4 4-4"/><path d="M12 17h9"/></svg>'
};

phrases.el.saveBtn.addEventListener("click", () => {
  const text = textInput.value.trim();
  if (text) {
    phrases.addPhrase(text);
    phrases.el.saveBtn.innerHTML = starSvg + ' 已收藏 ✓';
    phrases.el.saveBtn.classList.add("saved");
  }
});

// === Recording ===
const micSvg = '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const stopSvg = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

let recorder = null;
let chunks = [];
let isRecording = false;
let maxRecordTimer = null;
let timerInterval = null;
let recordSeconds = 0;
let isUploading = false;
let ws = null;

connectWebSocket();

function setActionButtonsDisabled(disabled) {
  submitButton.disabled = disabled;
  enterButton.disabled = disabled;
  pasteButton.disabled = disabled;
  undoButton.disabled = disabled;
}

if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
  showToast("当前浏览器无法直接录音，可改用音频上传兜底。", true);
  recordButton.disabled = true;
  fallbackButton.classList.remove("hidden");
}

recordButton.addEventListener("click", toggleRecording);

fallbackButton.addEventListener("click", () => fallbackFile.click());
fallbackFile.addEventListener("change", async () => {
  const file = fallbackFile.files?.[0];
  if (file) { await uploadAudio(file, fileExtensionFor(file.type)); fallbackFile.value = ""; }
});

async function toggleRecording() {
  if (isUploading) return;
  if (isRecording) stopRecording();
  else await startRecording();
}

function setRecordIdle() {
  iconEl.className = "record-icon record-icon-mic";
  iconEl.innerHTML = micSvg;
  labelEl.textContent = "录音";
}

function setRecordActive() {
  iconEl.className = "record-icon record-icon-stop";
  iconEl.innerHTML = stopSvg;
  labelEl.textContent = "停止";
}

function setRecordProcessing() {
  iconEl.className = "record-icon record-icon-mic";
  iconEl.innerHTML = micSvg;
  labelEl.textContent = "处理中…";
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    const mimeType = pickMimeType();
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (dataEvent) => { if (dataEvent.data.size > 0) chunks.push(dataEvent.data); });
    recorder.addEventListener("stop", async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      await uploadAudio(blob, fileExtensionFor(blob.type));
    });
    recorder.start();
    isRecording = true;
    recordSeconds = 0;
    recordButton.classList.add("recording");
    setRecordActive();
    setActionButtonsDisabled(true);
    setConnectionStatus(statusDot.className.includes("connected") ? "connected" : "connecting", "正在录音…");

    maxRecordTimer = setTimeout(() => { if (isRecording) { stopRecording(); showToast("已到 55 秒上限，正在上传音频..."); } }, 55_000);

    timerInterval = setInterval(() => {
      recordSeconds++;
      const mins = String(Math.floor(recordSeconds / 60)).padStart(2, "0");
      const secs = String(recordSeconds % 60).padStart(2, "0");
      labelEl.textContent = `${mins}:${secs}`;
    }, 1000);
  } catch (error) {
    showToast(`无法访问麦克风：${error.message}`, true);
  }
}

function stopRecording() {
  if (!isRecording || !recorder) return;
  isRecording = false;
  isUploading = true;
  clearTimeout(maxRecordTimer);
  clearInterval(timerInterval);
  recordButton.classList.remove("recording");
  recordButton.disabled = true;
  setRecordProcessing();
  showToast("正在上传音频...");
  recorder.stop();
}

async function uploadAudio(blob, extension) {
  try {
    if (!blob.size) { showToast("没有录到声音，请再试一次。", true); finishUpload(); return; }
    showToast("正在识别...");
    const formData = new FormData();
    formData.append("audio", blob, `voicebridge.${extension}`);
    formData.append("autoPaste", String(autoPasteEl.checked));
    if (windowSelector.targetWindow) {
      formData.append("targetAppName", windowSelector.targetWindow.appName);
      formData.append("targetWindowTitle", windowSelector.targetWindow.windowTitle);
    }
    const response = await fetch("/api/upload", { method: "POST", body: formData });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "上传失败");
    const output = payload.output || {};
    if (output.pasted) {
      showToast("已复制并自动粘贴。");
    } else {
      showCopyToast("已复制到电脑剪切板。", payload.text || "");
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    finishUpload();
  }
}

function finishUpload() {
  isUploading = false;
  recordButton.disabled = false;
  setRecordIdle();
  setActionButtonsDisabled(false);
}

// === WebSocket ===
function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.addEventListener("open", () => setConnectionStatus("connected", "已连接电脑端"));
  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "result" && payload.text) {
        textInput.value = payload.text;
        lastAutoPastedText = payload.text.trim();
        updateTextInputState();
      }
      if (payload.message) {
        showToast(payload.message, payload.type === "error");
      }
      if (payload.type === "output" && payload.copied && !payload.pasted) {
        if (payload.pasteError) {
          showToast("已复制，自动粘贴失败。", true);
        } else if (payload.text) {
          showCopyToast("已复制到剪切板。", payload.text);
        }
      }
    } catch {
      // Ignore malformed messages
    }
  });
  ws.addEventListener("close", (event) => {
    if (event.code === 1000) return; // Normal closure, no reconnect
    setConnectionStatus("error", "连接已断开，正在重连...");
    setTimeout(connectWebSocket, 1500);
  });
}

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function fileExtensionFor(mimeType) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg")) return "mp3";
  return "webm";
}
