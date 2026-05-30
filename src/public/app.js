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
  const saveBtn = document.querySelector("#savePhraseBtn");
  if (text) {
    saveBtn.classList.remove("hidden");
    saveBtn.classList.remove("saved");
    saveBtn.innerHTML = starSvg + " 收藏";
  } else {
    saveBtn.classList.add("hidden");
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
    this._windowCache = null;
    this._windowCacheTime = 0;
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
    const now = Date.now();
    if (this._windowCache && now - this._windowCacheTime < 5000) {
      this._renderWindows(this._windowCache);
      return;
    }
    this.el.list.innerHTML = '<p class="window-list-loading">加载中…</p>';
    try {
      const res = await fetch("/api/windows");
      const data = await res.json();
      if (!data.ok || !data.windows || data.windows.length === 0) {
        this.el.list.innerHTML = '<p class="window-list-empty">没有找到可输入的窗口</p>';
        return;
      }
      this._renderWindows(data.windows);
      this._windowCache = data.windows;
      this._windowCacheTime = Date.now();
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

// === CommandLibrary ===
class CommandLibrary {
  constructor(containerEl) {
    this.container = containerEl;
    this.tabScroll = document.getElementById("tabScroll");
    this.commands = [];
    this.filter = "";
    this.editingId = null;
    this.activeCategory = "最近";
    this._longPressTimer = null;
    this._longPressTriggered = false;
    this._longPressStartX = 0;
    this._longPressStartY = 0;
    this._bindContainerEvents();
    this.load();
  }

  _bindContainerEvents() {
    // Tab click delegation
    this.tabScroll.addEventListener("click", (e) => {
      const tab = e.target.closest(".tab-item");
      if (!tab) return;
      this.activeCategory = tab.dataset.category;
      this.renderTabs();
      this.render();
    });

    this.container.addEventListener("click", (e) => {
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
      this._longPressStartX = e.clientX;
      this._longPressStartY = e.clientY;
      this._longPressTimer = setTimeout(() => {
        this._longPressTriggered = true;
        this._enterEditMode(id);
      }, 500);
    });
    this.container.addEventListener("pointerup", () => { clearTimeout(this._longPressTimer); });
    this.container.addEventListener("pointerleave", () => { clearTimeout(this._longPressTimer); });
    this.container.addEventListener("pointermove", (e) => {
      if (this._longPressTimer) {
        const dx = e.clientX - this._longPressStartX;
        const dy = e.clientY - this._longPressStartY;
        if (dx * dx + dy * dy > 100) clearTimeout(this._longPressTimer);
      }
    });
  }

  async load() {
    try {
      const res = await fetch("/api/commands");
      this.commands = await res.json();
      // If "最近" is active but no commands have been used, fall back to first category
      if (this.activeCategory === "最近" && !this.commands.some(c => c.lastUsedAt)) {
        const cats = this._getCategories();
        if (cats.length > 0) this.activeCategory = cats[0][0];
      }
      // Set default active category if still null
      if (!this.activeCategory) {
        const cats = this._getCategories();
        if (cats.length > 0) this.activeCategory = cats[0][0];
      }
      this.renderTabs();
      this.render();
      await this._migrateLocalStoragePhrases();
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

  renderTabs() {
    this.tabScroll.innerHTML = "";
    const cats = this._getCategories();
    // Render "最近" virtual tab first
    const recentCount = this.commands.filter(c => c.lastUsedAt && !/^[──\-]{2,}/.test(c.label)).length;
    if (recentCount > 0) {
      const recentBtn = document.createElement("button");
      recentBtn.className = "tab-item" + (this.activeCategory === "最近" ? " active" : "");
      recentBtn.type = "button";
      recentBtn.dataset.category = "最近";
      const recentNameSpan = document.createElement("span");
      recentNameSpan.textContent = "最近";
      recentBtn.appendChild(recentNameSpan);
      const recentCountSpan = document.createElement("span");
      recentCountSpan.className = "tab-count";
      recentCountSpan.textContent = recentCount > 16 ? "16+" : String(recentCount);
      recentBtn.appendChild(recentCountSpan);
      this.tabScroll.appendChild(recentBtn);
    }
    cats.forEach(([category, cmds]) => {
      const btn = document.createElement("button");
      btn.className = "tab-item" + (category === this.activeCategory ? " active" : "");
      btn.type = "button";
      btn.dataset.category = category;
      const nameSpan = document.createElement("span");
      nameSpan.textContent = category;
      btn.appendChild(nameSpan);
      const countSpan = document.createElement("span");
      countSpan.className = "tab-count";
      countSpan.textContent = cmds.length;
      btn.appendChild(countSpan);
      this.tabScroll.appendChild(btn);
    });
    // Scroll active tab into view
    const activeTab = this.tabScroll.querySelector(".tab-item.active");
    if (activeTab) {
      activeTab.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }

  render(filter) {
    this.filter = filter || this.filter;
    const q = this.filter.toLowerCase();
    this.container.innerHTML = "";

    if (this.commands.length === 0) {
      this.container.innerHTML = '<p style="padding:12px;color:var(--text-muted);text-align:center;">暂无指令</p>';
      return;
    }

    // When searching, show results across all categories
    let cmdsToShow;
    if (q) {
      cmdsToShow = this.commands.filter(c => (c.label || "").toLowerCase().includes(q) || (c.text || "").toLowerCase().includes(q));
    } else if (this.activeCategory === "最近") {
      // Show recently used commands across all categories, deduplicated, sorted by lastUsedAt desc, max 16
      const seen = new Set();
      cmdsToShow = this.commands
        .filter(c => c.lastUsedAt && !/^[──\-]{2,}/.test(c.label) && !seen.has(c.id) && (seen.add(c.id), true))
        .sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0))
        .slice(0, 16);
    } else {
      cmdsToShow = this.commands.filter(c => (c.category || "未分类") === this.activeCategory);
    }

    // Sort by lastUsedAt only for "最近" and search
    if (q || this.activeCategory === "最近") {
      cmdsToShow.sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0));
    }

    if (cmdsToShow.length === 0) {
      this.container.innerHTML = '<p style="padding:12px;color:var(--text-muted);text-align:center;">没有匹配的指令</p>';
      return;
    }

    const grid = document.createElement("div");
    grid.className = "cmd-grid";
    // Compute top-4 recently used IDs for highlight (category tabs only)
    const recentIds = new Set();
    if (!q && this.activeCategory !== "最近") {
      cmdsToShow
        .filter(c => c.lastUsedAt && !/^[──\-]{2,}/.test(c.label))
        .sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0))
        .slice(0, 4)
        .forEach(c => recentIds.add(c.id));
    }
    cmdsToShow.forEach(cmd => {
      // Separator: label starts with ── or ---
      if (/^[──\-]{2,}/.test(cmd.label)) {
        const sep = document.createElement("div");
        sep.className = "cmd-separator";
        grid.appendChild(sep);
        return;
      }
      const btn = document.createElement("button");
      btn.className = "cmd-btn";
      if (recentIds.has(cmd.id)) btn.classList.add("cmd-recent");
      btn.type = "button";
      btn.dataset.id = cmd.id;
      btn.title = cmd.text;
      if (cmd.text.startsWith("/") || /^(npm|node|copyclaw|npx)\b/.test(cmd.text)) {
        btn.classList.add("slash");
      }
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
    this.container.appendChild(grid);
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
      this.renderTabs();
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
      this.renderTabs();
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
      // Switch to the category of the newly added command
      this.activeCategory = created.category || "未分类";
      this.renderTabs();
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
    // Prevent iOS zoom bug
    document.activeElement?.blur();
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

  async _migrateLocalStoragePhrases() {
    const STORAGE_KEY = "voicebridge_phrases";
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const phrases = JSON.parse(raw);
      if (!Array.isArray(phrases) || phrases.length === 0) return;
      const migratedKey = "voicebridge_phrases_migrated";
      if (localStorage.getItem(migratedKey)) return;
      for (const phrase of phrases) {
        if (phrase.text) {
          await fetch("/api/commands", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: phrase.text,
              label: phrase.text.length > 8 ? phrase.text.slice(0, 8) + "\u2026" : phrase.text,
              category: "通用",
            }),
          });
        }
      }
      localStorage.setItem(migratedKey, "true");
      const res = await fetch("/api/commands");
      this.commands = await res.json();
      this.renderTabs();
      this.render();
    } catch { }
  }
}

// === Initialize ===
const windowSelector = new WindowSelector();
const commandLibrary = new CommandLibrary(document.getElementById("commandLibrary"));

// === Text Input Events ===
updateTextInputState();

textInput.addEventListener("input", () => {
  lastAutoPastedText = "";
  updateTextInputState();
});

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextInput(); }
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

function sendQuickCommand(text, label) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg = { type: "phrase", text, autoPaste: autoPasteEl.checked };
    if (windowSelector.targetWindow) msg.targetWindow = windowSelector.targetWindow;
    copyToPhoneClipboard(text);
    ws.send(JSON.stringify(msg));
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

// === Save / Add Command Button ===
const savePhraseBtn = document.querySelector("#savePhraseBtn");
savePhraseBtn.addEventListener("click", () => {
  const text = textInput.value.trim();
  if (text) {
    commandLibrary.openAddDialog(text);
  }
});

// === Command Library Events ===
const cmdSearchToggle = document.querySelector("#cmdSearchToggle");
const cmdSearchBar = document.querySelector("#cmdSearchBar");
const cmdSearchInput = document.querySelector("#cmdSearchInput");
const addCmdCancelBtn = document.querySelector("#addCmdCancelBtn");
const addCmdConfirmBtn = document.querySelector("#addCmdConfirmBtn");
const addCommandCategory = document.querySelector("#addCommandCategory");
const addCommandNewCategory = document.querySelector("#addCommandNewCategory");

cmdSearchToggle.addEventListener("click", () => {
  cmdSearchBar.classList.toggle("hidden");
  if (!cmdSearchBar.classList.contains("hidden")) {
    cmdSearchInput.focus();
  } else {
    cmdSearchInput.value = "";
    commandLibrary.filter = "";
    commandLibrary.render();
  }
});

cmdSearchInput.addEventListener("input", () => {
  commandLibrary.render(cmdSearchInput.value);
});

addCmdCancelBtn.addEventListener("click", () => {
  commandLibrary.closeAddDialog();
});

addCmdConfirmBtn.addEventListener("click", () => {
  commandLibrary.confirmAdd();
});

addCommandCategory.addEventListener("change", () => {
  if (addCommandCategory.value === "__new__") {
    addCommandNewCategory.classList.remove("hidden");
    addCommandNewCategory.focus();
  } else {
    addCommandNewCategory.classList.add("hidden");
  }
});

document.querySelector(".add-cmd-overlay").addEventListener("click", () => {
  commandLibrary.closeAddDialog();
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
  let wsRetryDelay = 1500;
  ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.addEventListener("open", () => {
    wsRetryDelay = 1500;
    setConnectionStatus("connected", "已连接电脑端");
  });
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
    setTimeout(connectWebSocket, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, 60000);
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
