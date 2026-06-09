import { CloudRealtime, getPhoneDeviceId, isDesktopDeviceCandidate } from "./cloudRealtime.js";
import { createBillingSession } from "./billing.js";
import { recordWavUntilStopped } from "./cloudRecorder.js";
import { transcribeCloudAudio } from "./cloudTranscribe.js";

// === Element References ===
const appConfig = window.__VB_CONFIG || {};
const statusDot = document.querySelector("#statusDot");
const statusBadge = document.querySelector("#statusBadge");
const textInput = document.querySelector("#textInput");
const charCount = document.querySelector("#charCount");
const autoPasteEl = document.querySelector("#autoPaste");
const toastEl = document.querySelector("#toast");
const pageRefreshButton = document.querySelector("#pageRefreshButton");
const cloudDeviceSelect = document.querySelector("#cloudDeviceSelect");
const billingActions = document.querySelector("#billingActions");
const planBadge = document.querySelector("#planBadge");
const accountDrawerBtn = document.querySelector("#accountDrawerBtn");
const isCloudMode = appConfig.voicebridgeMode === "cloud";
let cloudRealtime = null;
let selectedCloudDeviceId = "";
let activeCloudUserId = "";
let activeCloudPhoneDeviceId = "";

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

  // In edit mode, hide save button — handled by edit UI
  if (commandLibrary.editingId) {
    saveBtn.classList.add("hidden");
    commandLibrary._checkEditChanges();
    return;
  }

  if (text) {
    saveBtn.classList.remove("hidden");
    saveBtn.classList.remove("saved");
    saveBtn.innerHTML = starSvg + " 收藏";
  } else {
    saveBtn.classList.add("hidden");
  }
}

let lastAutoPastedText = "";
let lastAutoPasteTimer = null;

async function sendTextInput() {
  const text = textInput.value.trim();
  if (!text) return;
  if (text.length > 2000) {
    showToast("文本过长，最多支持 2000 个字符", true);
    return;
  }
  if (text === lastAutoPastedText) {
    textInput.value = "";
    updateTextInputState();
    lastAutoPastedText = "";
    clearTimeout(lastAutoPasteTimer);
    lastAutoPasteTimer = null;
    showToast("该文本已通过语音自动发送。");
    return;
  }
  lastAutoPastedText = "";
  clearTimeout(lastAutoPasteTimer);
  lastAutoPasteTimer = null;
  const accepted = await sendTextToDesktop(text);
  if (accepted) {
    textInput.value = "";
    updateTextInputState();
  }
}

async function sendTextToDesktop(text, { localSuccessMessage = "已发送到电脑。" } = {}) {
  if ((window.__VB_CONFIG || {}).voicebridgeMode === "cloud") {
    if (!cloudRealtime || !selectedCloudDeviceId) {
      showToast("请先打开桌面客户端。", true);
      return false;
    }
    try {
      const sendPromise = cloudRealtime.sendText({
        targetDeviceId: selectedCloudDeviceId,
        text,
        autoPaste: autoPasteEl.checked
      });
      showToast("已发送，等待桌面端确认...");
      await sendPromise;
      return true;
    } catch (error) {
      showToast(error.message || "发送失败，请稍后重试。", true);
      return false;
    }
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
    showToast(localSuccessMessage);
    return true;
  } else {
    showToast("发送失败，请检查连接。", true);
    return false;
  }
}

async function handleAuthState(event) {
  const { session, user } = event.detail;
  updateBillingControls(Boolean(session));
  if (!isCloudMode) return;
  if (!session || !user || !window.VoiceBridgeAuth?.supabase) {
    if (activeCloudUserId) {
      showToast("会话已过期，请重新登录");
      activeCloudUserId = "";
    }
    await stopCloudRealtime();
    resetCloudDeviceSelect();
    return;
  }

  const phoneDeviceId = getPhoneDeviceId();
  if (cloudRealtime && activeCloudUserId === user.id && activeCloudPhoneDeviceId === phoneDeviceId) {
    return;
  }

  await stopCloudRealtime();
  activeCloudUserId = user.id;
  activeCloudPhoneDeviceId = phoneDeviceId;
  cloudDeviceSelect.classList.remove("hidden");
  const realtime = new CloudRealtime({
    supabase: window.VoiceBridgeAuth.supabase,
    user,
    phoneDeviceId,
    onDevices: (devices) => {
      const desktopDevices = devices.filter((device) => isDesktopDeviceCandidate(device, phoneDeviceId));
      renderCloudDeviceOptions(desktopDevices);
    },
    onAck: (ack) => {
      showToast(ack.status === "success" ? "已发送到桌面端。" : `桌面端执行失败：${ack.detail}`);
    },
    onStatus: () => setConnectionStatus("connected", "云端已连接")
  });
  cloudRealtime = realtime;
  // 更新 plan badge
  const sb = window.VoiceBridgeAuth?.supabase;
  if (sb && planBadge) {
    sb.from("subscriptions").select("status").eq("user_id", user.id).maybeSingle()
      .then(({ data: sub }) => {
        const plan = sub && isPaidStatus(sub.status) ? "pro" : "free";
        planBadge.textContent = plan === "pro" ? "Pro" : "Free";
        planBadge.classList.toggle("pro", plan === "pro");
      });
  }
  try {
    await realtime.start();
  } catch (error) {
    if (cloudRealtime !== realtime || activeCloudUserId !== user.id || activeCloudPhoneDeviceId !== phoneDeviceId) {
      return;
    }
    showToast(error.message || "云端连接失败，请稍后重试。", true);
    setConnectionStatus("error", "云端连接失败");
    await stopCloudRealtime();
    resetCloudDeviceSelect();
  }
}

window.addEventListener("voicebridge:auth", (event) => {
  void handleAuthState(event);
});

if (window.VoiceBridgeAuth) {
  void handleAuthState({
    detail: {
      session: window.VoiceBridgeAuth.session,
      user: window.VoiceBridgeAuth.user
    }
  });
}

cloudDeviceSelect?.addEventListener("change", () => {
  selectedCloudDeviceId = cloudDeviceSelect.value;
});

function renderCloudDeviceOptions(desktopDevices) {
  const previousDeviceId = selectedCloudDeviceId;
  const options = desktopDevices.length
    ? desktopDevices.map((device) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.name || device.deviceId;
      return option;
    })
    : [createCloudPlaceholderOption()];

  cloudDeviceSelect.replaceChildren(...options);

  if (desktopDevices.some((device) => device.deviceId === previousDeviceId)) {
    selectedCloudDeviceId = previousDeviceId;
    cloudDeviceSelect.value = previousDeviceId;
  } else {
    selectedCloudDeviceId = desktopDevices[0]?.deviceId || "";
    cloudDeviceSelect.value = selectedCloudDeviceId;
  }
}

function createCloudPlaceholderOption() {
  const option = document.createElement("option");
  option.value = "";
  option.textContent = "等待桌面端上线";
  return option;
}

async function stopCloudRealtime() {
  await cloudRealtime?.stop();
  cloudRealtime = null;
  activeCloudUserId = "";
  activeCloudPhoneDeviceId = "";
}

function resetCloudDeviceSelect() {
  selectedCloudDeviceId = "";
  cloudDeviceSelect.replaceChildren(createCloudPlaceholderOption());
  cloudDeviceSelect.classList.add("hidden");
}

const PLAN_LIMITS = {
  free: { monthlySeconds: 600, maxAudioSeconds: 60, rateLimitPerMinute: 10 },
  pro: { monthlySeconds: 18000, maxAudioSeconds: 60, rateLimitPerMinute: 30 },
};

function isPaidStatus(status) {
  return status === "active" || status === "trialing";
}

function formatRelativeTime(diffMs) {
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}个月前`;
}

function updateBillingControls(hasSession) {
  const visible = isCloudMode && hasSession;
  billingActions?.classList.toggle("hidden", !visible);
  if (accountDrawerBtn) accountDrawerBtn.disabled = !visible;
  planBadge?.classList.toggle("hidden", !visible);
}

async function openBillingSession(functionName, button) {
  if (!button) return;
  button.disabled = true;
  try {
    const payload = await createBillingSession({
      supabase: window.VoiceBridgeAuth?.supabase,
      functionName
    });
    location.href = payload.url;
  } catch (error) {
    showToast(error.message || "订阅请求失败，请稍后重试。", true);
    button.disabled = false;
  }
}

updateBillingControls(Boolean(window.VoiceBridgeAuth?.session));

// === Stripe Billing Callback ===
(function handleBillingCallback() {
  const params = new URLSearchParams(location.search);
  const billing = params.get("billing");
  if (billing === "success") {
    showToast("订阅成功，欢迎使用 Pro 方案");
    history.replaceState(null, "", location.pathname);
  } else if (billing === "cancel") {
    showToast("订阅已取消");
    history.replaceState(null, "", location.pathname);
  }
})();

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
    try {
      if (this.selectedWindow) localStorage.setItem(WindowSelector.STORAGE_KEY, JSON.stringify(this.selectedWindow));
      else localStorage.removeItem(WindowSelector.STORAGE_KEY);
    } catch {
      // localStorage 不可用或已满，静默失败
    }
  }

  _toggle() { this._isOpen ? this._close() : this._open(); }
  _open() { this._isOpen = true; this.el.dropdown.classList.remove("hidden"); this.el.btn.setAttribute("aria-expanded", "true"); this._fetchWindows(); }
  _close() { this._isOpen = false; this.el.dropdown.classList.add("hidden"); this.el.btn.setAttribute("aria-expanded", "false"); }

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
      if (!res.ok) {
        console.error("API error:", res.status, await res.text().catch(() => ""));
        this.el.list.innerHTML = '<p class="window-list-empty">获取窗口失败</p>';
        return;
      }
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
        btn.setAttribute("aria-selected", String(isSelected));
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
      // Command button click — disabled during edit mode
      const btn = e.target.closest(".cmd-btn");
      if (!btn) return;
      if (this.editingId) return;
      const id = btn.dataset.id;
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
      if (!res.ok) {
        console.error("API error:", res.status, await res.text().catch(() => ""));
        this.commands = [];
      } else {
        this.commands = await res.json();
      }
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
      recentBtn.setAttribute("role", "tab");
      recentBtn.setAttribute("aria-selected", String(this.activeCategory === "最近"));
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
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(category === this.activeCategory));
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
    // Compute global top-16 recently used IDs for highlight (all tabs, not during search)
    const recentIds = new Set();
    if (!q) {
      this.commands
        .filter(c => c.lastUsedAt && !/^[──\-]{2,}/.test(c.label))
        .sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0))
        .slice(0, 16)
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
      if (this.editingId) btn.classList.add("dimmed");
      const labelSpan = document.createElement("span");
      labelSpan.className = "cmd-label";
      labelSpan.textContent = cmd.label;
      btn.appendChild(labelSpan);
      grid.appendChild(btn);
    });
    this.container.appendChild(grid);
  }

  _enterEditMode(id) {
    const cmd = this.commands.find(c => c.id === id);
    if (!cmd) return;
    this.editingId = id;

    // Populate input area
    const editLabel = document.getElementById("editLabelInput");
    const inputCard = document.getElementById("inputCard");
    editLabel.value = cmd.label;
    editLabel.classList.remove("hidden");
    textInput.value = cmd.text;
    textInput.rows = 5;
    textInput.placeholder = "编辑指令内容…";
    inputCard.classList.add("editing");

    // Store originals for change detection
    this._editOriginalLabel = cmd.label;
    this._editOriginalText = cmd.text;

    // Show edit buttons, hide save button
    document.getElementById("savePhraseBtn").classList.add("hidden");
    document.getElementById("editDeleteBtn").classList.remove("hidden");
    document.getElementById("editSaveBtn").classList.add("hidden");
    document.getElementById("editCancelBtn").classList.add("hidden");

    // Disable primary actions during edit
    document.getElementById("submitButton").disabled = true;
    document.getElementById("submitButton").classList.add("dimmed");
    document.getElementById("recordButton").disabled = true;
    document.getElementById("recordButton").classList.add("dimmed");
    document.getElementById("enterButton").disabled = true;
    document.getElementById("enterButton").classList.add("dimmed");

    // Scroll to top so user sees the input area
    inputCard.scrollIntoView({ behavior: "smooth", block: "nearest" });

    updateTextInputState();
    this.render();
  }

  _exitEditMode(save) {
    if (!this.editingId) return;

    if (save) {
      const newLabel = document.getElementById("editLabelInput").value.trim();
      const newText = textInput.value.trim();
      if (newLabel && newText) {
        this._updateCommand(this.editingId, { label: newLabel, text: newText });
        showToast("已保存指令。");
      }
    }

    // Restore input area
    const editLabel = document.getElementById("editLabelInput");
    const inputCard = document.getElementById("inputCard");
    editLabel.value = "";
    editLabel.classList.add("hidden");
    textInput.value = "";
    textInput.rows = 3;
    textInput.placeholder = "输入文字，或语音识别…";
    inputCard.classList.remove("editing");

    // Hide edit buttons
    document.getElementById("editDeleteBtn").classList.add("hidden");
    document.getElementById("editSaveBtn").classList.add("hidden");
    document.getElementById("editCancelBtn").classList.add("hidden");

    // Re-enable primary actions
    document.getElementById("submitButton").disabled = false;
    document.getElementById("submitButton").classList.remove("dimmed");
    document.getElementById("recordButton").disabled = false;
    document.getElementById("recordButton").classList.remove("dimmed");
    document.getElementById("enterButton").disabled = false;
    document.getElementById("enterButton").classList.remove("dimmed");

    this.editingId = null;
    this._editOriginalLabel = null;
    this._editOriginalText = null;
    updateTextInputState();
    this.render();
  }

  _checkEditChanges() {
    if (!this.editingId) return;
    const currentLabel = document.getElementById("editLabelInput").value;
    const currentText = textInput.value;
    const changed = currentLabel.trim() !== this._editOriginalLabel || currentText.trim() !== this._editOriginalText;
    document.getElementById("editSaveBtn").classList.toggle("hidden", !changed);
    document.getElementById("editCancelBtn").classList.toggle("hidden", !changed);
  }

  async _deleteCommand(id) {
    try {
      await fetch(`/api/commands/${id}`, { method: "DELETE" });
      this.commands = this.commands.filter(c => c.id !== id);
      showToast("已删除指令。");
      this._exitEditMode(false);
    } catch {
      showToast("删除失败。", true);
      this._exitEditMode(false);
    }
  }

  async _updateCommand(id, updates) {
    try {
      const res = await fetch(`/api/commands/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates)
      });
      if (!res.ok) {
        console.error("API error:", res.status, await res.text().catch(() => ""));
        return;
      }
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
        body: JSON.stringify({ lastUsedAt: Date.now() })
      });
      if (!res.ok) {
        console.error("API error:", res.status, await res.text().catch(() => ""));
        return;
      }
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
      if (!res.ok) {
        console.error("API error:", res.status, await res.text().catch(() => ""));
        showToast("添加失败。", true);
        return;
      }
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
      if (!res.ok) {
        console.error("API error:", res.status, await res.text().catch(() => ""));
      } else {
        this.commands = await res.json();
      }
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
  clearTimeout(lastAutoPasteTimer);
  lastAutoPasteTimer = null;
  updateTextInputState();
});

textInput.addEventListener("keydown", (e) => {
  if (commandLibrary.editingId) {
    if (e.key === "Escape") { e.preventDefault(); commandLibrary._exitEditMode(false); }
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextInput(); }
});

// === Edit Mode Button Events ===
document.getElementById("editLabelInput").addEventListener("keydown", (e) => {
  if (!commandLibrary.editingId) return;
  if (e.key === "Escape") { e.preventDefault(); commandLibrary._exitEditMode(false); return; }
  if (e.key === "Enter") {
    e.preventDefault();
    commandLibrary._exitEditMode(true);
    textInput.focus();
  }
});
document.getElementById("editLabelInput").addEventListener("input", () => {
  if (commandLibrary.editingId) commandLibrary._checkEditChanges();
});

document.getElementById("editDeleteBtn").addEventListener("click", () => {
  if (commandLibrary.editingId) commandLibrary._deleteCommand(commandLibrary.editingId);
});

document.getElementById("editSaveBtn").addEventListener("click", () => {
  if (commandLibrary.editingId) commandLibrary._exitEditMode(true);
});

document.getElementById("editCancelBtn").addEventListener("click", () => {
  if (commandLibrary.editingId) commandLibrary._exitEditMode(false);
});

// Click outside input-card to exit edit mode (only when no changes)
document.addEventListener("click", (e) => {
  if (!commandLibrary.editingId) return;
  if (e.target.closest(".input-card") || e.target.closest(".library-panel")) return;
  const changed = document.getElementById("editLabelInput").value.trim() !== commandLibrary._editOriginalLabel
    || textInput.value.trim() !== commandLibrary._editOriginalText;
  if (!changed) commandLibrary._exitEditMode(false);
});

// === Paste & Undo Buttons ===
const pasteButton = document.querySelector("#pasteButton");
const undoButton = document.querySelector("#undoButton");
const escButton = document.querySelector("#escButton");
const deleteButton = document.querySelector("#deleteButton");

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

escButton.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "escape" }));
    showToast("已按 Esc。");
  } else {
    showToast("发送失败，请检查连接。", true);
  }
});

deleteButton.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "delete" }));
    showToast("已按删除。");
  } else {
    showToast("发送失败，请检查连接。", true);
  }
});

async function sendQuickCommand(text, label) {
  await sendTextToDesktop(text, { localSuccessMessage: "已发送快捷指令。" });
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
let recordingStartedAt = 0;
let currentRecordingDurationMs = null;
let isUploading = false;
let ws = null;

const BrowserAudioContext = window.AudioContext || window.webkitAudioContext;

if (!isCloudMode) {
  connectWebSocket();
}

function setActionButtonsDisabled(disabled) {
  submitButton.disabled = disabled;
  enterButton.disabled = disabled;
  pasteButton.disabled = disabled;
  undoButton.disabled = disabled;
  escButton.disabled = disabled;
  deleteButton.disabled = disabled;
}

if (!navigator.mediaDevices?.getUserMedia || (isCloudMode ? !BrowserAudioContext : !window.MediaRecorder)) {
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
  if (isRecording) await stopRecording();
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

function beginRecordingState() {
  isRecording = true;
  recordSeconds = 0;
  recordingStartedAt = performance.now();
  currentRecordingDurationMs = null;
  recordButton.classList.add("recording");
  setRecordActive();
  setActionButtonsDisabled(true);
  setConnectionStatus(statusDot.className.includes("connected") ? "connected" : "connecting", "正在录音…");

  maxRecordTimer = setTimeout(() => {
    if (isRecording) {
      void stopRecording().catch((error) => {
        console.error("Failed to stop recording:", error);
        showToast(error.message || "录音停止失败，请重试。", true);
        finishUpload();
      });
      showToast("已到 55 秒上限，正在上传音频...");
    }
  }, 55_000);

  timerInterval = setInterval(() => {
    recordSeconds++;
    const mins = String(Math.floor(recordSeconds / 60)).padStart(2, "0");
    const secs = String(recordSeconds % 60).padStart(2, "0");
    labelEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

async function startRecording() {
  try {
    if (isCloudMode) {
      recorder = await recordWavUntilStopped({
        onStopReady: async (blob) => uploadAudio(blob, "wav")
      });
      beginRecordingState();
      return;
    }

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
    beginRecordingState();
  } catch (error) {
    showToast(`无法访问麦克风：${error.message}`, true);
  }
}

async function stopRecording() {
  if (!isRecording || !recorder) return;
  isRecording = false;
  isUploading = true;
  currentRecordingDurationMs = getCurrentRecordingDurationMs();
  clearTimeout(maxRecordTimer);
  clearInterval(timerInterval);
  recordButton.classList.remove("recording");
  recordButton.disabled = true;
  setRecordProcessing();
  showToast("正在上传音频...");
  if (isCloudMode && typeof recorder.stop === "function") {
    try {
      await recorder.stop();
    } catch (error) {
      showToast(error.message || "录音处理失败，请重试。", true);
      finishUpload();
    }
    return;
  }
  recorder.stop();
}

async function uploadAudio(blob, extension) {
  try {
    if (!blob.size) { showToast("没有录到声音，请再试一次。", true); finishUpload(); return; }
    showToast("正在识别...");
    if (isCloudMode) {
      const payload = await transcribeCloudAudio({
        audio: blob,
        filename: `voicebridge.${extension}`,
        durationMs: currentRecordingDurationMs
      });
      const text = (payload.text || "").trim();
      if (!text) throw new Error("识别完成，但没有返回可用文字。");
      textInput.value = text;
      updateTextInputState();
      const accepted = await sendTextToDesktop(text);
      if (accepted && textInput.value.trim() === text) {
        textInput.value = "";
        updateTextInputState();
      }
      return;
    }

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
  recordingStartedAt = 0;
  currentRecordingDurationMs = null;
  if (commandLibrary.editingId) {
    recordButton.disabled = true;
    submitButton.disabled = true;
    enterButton.disabled = true;
  } else {
    recordButton.disabled = false;
    setActionButtonsDisabled(false);
  }
  setRecordIdle();
}

// === WebSocket ===
let wsRetryTimer = null;
let wsVisibilityHandler = null;

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  let wsRetryDelay = 1500;
  ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.addEventListener("open", () => {
    wsRetryDelay = 1500;
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
    if (wsVisibilityHandler) {
      document.removeEventListener("visibilitychange", wsVisibilityHandler);
      wsVisibilityHandler = null;
    }
    setConnectionStatus("connected", "已连接电脑端");
  });
  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "result" && payload.text) {
        if (!commandLibrary.editingId) {
          textInput.value = payload.text;
          lastAutoPastedText = payload.text.trim();
          clearTimeout(lastAutoPasteTimer);
          lastAutoPasteTimer = setTimeout(() => { lastAutoPastedText = ""; lastAutoPasteTimer = null; }, 5000);
          updateTextInputState();
        }
      }
      if (payload.message) {
        showToast(payload.message, payload.type === "error");
      }
      if (payload.type === "output") {
        if (!payload.copied) {
          showToast("识别成功，但写入剪切板失败。", true);
        } else if (!payload.pasted) {
          if (payload.pasteError) {
            showToast("已复制，自动粘贴失败。", true);
          } else if (payload.text) {
            showCopyToast("已复制到剪切板。", payload.text);
          }
        }
      }
    } catch {
      // Ignore malformed messages
    }
  });
  ws.addEventListener("close", (event) => {
    if (event.code === 1000) return; // Normal closure, no reconnect
    setConnectionStatus("error", "连接已断开，正在重连...");
    clearTimeout(wsRetryTimer);
    wsRetryTimer = setTimeout(connectWebSocket, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, 60000);
    if (wsVisibilityHandler) {
      document.removeEventListener("visibilitychange", wsVisibilityHandler);
    }
    wsVisibilityHandler = () => {
      if (document.visibilityState === "visible" && (!ws || ws.readyState !== WebSocket.OPEN)) {
        clearTimeout(wsRetryTimer);
        wsRetryTimer = null;
        document.removeEventListener("visibilitychange", wsVisibilityHandler);
        wsVisibilityHandler = null;
        wsRetryDelay = 1500;
        connectWebSocket();
      }
    };
    document.addEventListener("visibilitychange", wsVisibilityHandler);
  });
}

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function fileExtensionFor(mimeType) {
  if (mimeType.includes("wav") || mimeType.includes("wave")) return "wav";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg")) return "mp3";
  return "webm";
}

function getCurrentRecordingDurationMs() {
  if (recordingStartedAt > 0 && typeof performance !== "undefined" && typeof performance.now === "function") {
    return Math.max(1, Math.round(performance.now() - recordingStartedAt));
  }
  return recordSeconds > 0 ? recordSeconds * 1000 : null;
}

// === Account Drawer ===
class AccountDrawer {
  constructor() {
    this.el = {
      drawer: document.querySelector("#accountDrawer"),
      overlay: document.querySelector(".account-drawer-overlay"),
      closeBtn: document.querySelector("#accountDrawerClose"),
      body: document.querySelector("#accountDrawerBody"),
    };
    this._isOpen = false;
    this._init();
  }

  _init() {
    this.el.closeBtn?.addEventListener("click", () => this.close());
    this.el.overlay?.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._isOpen) this.close();
    });
  }

  open() {
    this._isOpen = true;
    this.el.drawer?.classList.remove("hidden");
    this._render();
  }

  close() {
    this._isOpen = false;
    this.el.drawer?.classList.add("hidden");
  }

  async _render() {
    const body = this.el.body;
    if (!body) return;
    body.innerHTML = "<p style='text-align:center;color:var(--text-muted)'>加载中…</p>";
    try {
      const data = await this._fetchData();
      body.replaceChildren(
        this._renderPlan(data),
        this._renderPricing(data),
        this._renderUsage(data),
        this._renderSubscription(data),
        this._renderProfile(data),
        this._renderDevices(data),
      );
    } catch (error) {
      body.innerHTML = `<p style='text-align:center;color:var(--danger)'>${error.message || "加载失败"}</p>`;
    }
  }

  async _fetchData() {
    const supabase = window.VoiceBridgeAuth?.supabase;
    const user = window.VoiceBridgeAuth?.user;
    if (!supabase || !user) throw new Error("请先登录");

    const [subRes, usageRes, devicesRes] = await Promise.all([
      supabase.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle(),
      supabase.from("usage_events").select("status, claim_seconds").eq("user_id", user.id),
      supabase.from("devices").select("*").eq("user_id", user.id).order("last_seen_at", { ascending: false }),
    ]);

    const subscription = subRes.data || null;
    const usageEvents = usageRes.data || [];
    const devices = devicesRes.data || [];

    const plan = subscription && isPaidStatus(subscription.status) ? "pro" : "free";
    const usedSeconds = usageEvents.filter((e) => e.status === "success").reduce((sum, e) => sum + (e.claim_seconds || 0), 0);
    const totalCount = usageEvents.length;
    const successCount = usageEvents.filter((e) => e.status === "success").length;
    const rejectedCount = usageEvents.filter((e) => e.status === "rejected").length;

    return { subscription, plan, usedSeconds, totalCount, successCount, rejectedCount, devices, user };
  }

  _renderPlan(data) {
    const section = document.createElement("div");
    section.className = "account-section";

    const title = document.createElement("p");
    title.className = "account-section-title";
    title.textContent = "当前方案";
    section.appendChild(title);

    const badge = document.createElement("span");
    badge.className = `plan-badge ${data.plan === "pro" ? "pro" : ""}`;
    badge.textContent = data.plan === "pro" ? "Pro" : "Free";
    section.appendChild(badge);

    const limits = PLAN_LIMITS[data.plan];
    const pct = Math.min(100, Math.round((data.usedSeconds / limits.monthlySeconds) * 100));

    const stats = document.createElement("div");
    stats.className = "usage-stats";
    stats.innerHTML = `
      <div class="usage-stat-row">
        <span class="usage-stat-label">已用 / 月额度</span>
        <span class="usage-stat-value">${data.usedSeconds.toLocaleString()} / ${limits.monthlySeconds.toLocaleString()} 秒 (${pct}%)</span>
      </div>
    `;
    section.appendChild(stats);

    const track = document.createElement("div");
    track.className = "usage-bar-track";
    const fill = document.createElement("div");
    fill.className = `usage-bar-fill ${pct >= 90 ? "critical" : pct >= 70 ? "warning" : ""}`;
    fill.style.width = pct + "%";
    track.appendChild(fill);
    section.appendChild(track);

    return section;
  }
  _renderPricing(data) {
    const section = document.createElement("div");
    section.className = "account-section";

    const title = document.createElement("p");
    title.className = "account-section-title";
    title.textContent = "方案对比";
    section.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "pricing-grid";

    for (const [key, label] of [["free", "Free"], ["pro", "Pro"]]) {
      const card = document.createElement("div");
      card.className = `pricing-card ${data.plan === key ? "active" : ""}`;

      const name = document.createElement("p");
      name.className = "pricing-card-name";
      name.textContent = label + (data.plan === key ? " ✓" : "");
      card.appendChild(name);

      const limits = PLAN_LIMITS[key];
      for (const [lKey, lLabel] of [["monthlySeconds", "月额度"], ["maxAudioSeconds", "单次最长"], ["rateLimitPerMinute", "速率(次/分)"]]) {
        const item = document.createElement("p");
        item.className = "pricing-card-item";
        item.textContent = `${lLabel}: ${limits[lKey]}秒`;
        card.appendChild(item);
      }

      if (key === "pro" && data.plan !== "pro") {
        const btn = document.createElement("button");
        btn.className = "pricing-card-btn";
        btn.type = "button";
        btn.textContent = "升级 Pro";
        btn.addEventListener("click", () => {
          void openBillingSession("billing-create-checkout-session", btn);
        });
        card.appendChild(btn);
      } else if (key === "pro" && data.plan === "pro") {
        const badge = document.createElement("span");
        badge.className = "pricing-card-badge";
        badge.textContent = "当前方案";
        card.appendChild(badge);
      }

      grid.appendChild(card);
    }

    section.appendChild(grid);
    return section;
  }
  _renderUsage(data) {
    const section = document.createElement("div");
    section.className = "account-section";

    const title = document.createElement("p");
    title.className = "account-section-title";
    title.textContent = "用量明细";
    section.appendChild(title);

    const successRate = data.totalCount > 0 ? Math.round((data.successCount / data.totalCount) * 100) : 0;

    const rows = [
      ["总转写时长", `${data.usedSeconds.toLocaleString()} 秒`],
      ["转写次数", `${data.successCount} 次`],
      ["成功率", `${successRate}%`],
      ["拒绝次数", `${data.rejectedCount} 次`],
    ];

    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "account-row";
      row.innerHTML = `<span class="account-row-label">${label}</span><span class="account-row-value">${value}</span>`;
      section.appendChild(row);
    }

    return section;
  }
  _renderSubscription(data) {
    const section = document.createElement("div");
    section.className = "account-section";

    const title = document.createElement("p");
    title.className = "account-section-title";
    title.textContent = "订阅管理";
    section.appendChild(title);

    const sub = data.subscription;
    if (!sub) {
      const hint = document.createElement("p");
      hint.style.cssText = "margin:0;font-size:13px;color:var(--text-muted)";
      hint.textContent = "暂无订阅";
      section.appendChild(hint);
      return section;
    }

    const statusMap = { active: "有效", trialing: "试用中", past_due: "逾期", canceled: "已取消", unpaid: "未支付" };
    const rows = [
      ["状态", statusMap[sub.status] || sub.status],
    ];

    if (sub.current_period_start && sub.current_period_end) {
      const fmt = (d) => new Date(d).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
      rows.push(["当前周期", `${fmt(sub.current_period_start)} - ${fmt(sub.current_period_end)}`]);
    }

    if (sub.cancel_at_period_end) {
      const warn = document.createElement("p");
      warn.style.cssText = "margin:6px 0 0;font-size:13px;color:#d97706";
      warn.textContent = `将于 ${new Date(sub.current_period_end).toLocaleDateString("zh-CN")} 到期`;
      section.appendChild(warn);
    }

    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "account-row";
      row.innerHTML = `<span class="account-row-label">${label}</span><span class="account-row-value">${value}</span>`;
      section.appendChild(row);
    }

    const portalBtn = document.createElement("button");
    portalBtn.className = "account-action-btn";
    portalBtn.type = "button";
    portalBtn.textContent = "管理订阅";
    portalBtn.addEventListener("click", () => {
      void openBillingSession("billing-create-portal-session", portalBtn);
    });
    section.appendChild(portalBtn);

    return section;
  }
  _renderProfile(data) {
    const section = document.createElement("div");
    section.className = "account-section";

    const title = document.createElement("p");
    title.className = "account-section-title";
    title.textContent = "个人资料";
    section.appendChild(title);

    // 邮箱行（脱敏）
    const email = data.user?.email || "";
    const masked = email.replace(/(.{2})(.*)(@.*)/, "$1***$3");
    const emailRow = document.createElement("div");
    emailRow.className = "account-row";
    emailRow.innerHTML = `<span class="account-row-label">邮箱</span><span class="account-row-value">${masked}</span>`;
    section.appendChild(emailRow);

    const emailEditBtn = document.createElement("button");
    emailEditBtn.className = "account-action-btn";
    emailEditBtn.type = "button";
    emailEditBtn.textContent = "修改邮箱";
    section.appendChild(emailEditBtn);

    // 密码行
    const pwdRow = document.createElement("div");
    pwdRow.className = "account-row";
    pwdRow.innerHTML = `<span class="account-row-label">密码</span><span class="account-row-value">••••••</span>`;
    section.appendChild(pwdRow);

    const pwdEditBtn = document.createElement("button");
    pwdEditBtn.className = "account-action-btn";
    pwdEditBtn.type = "button";
    pwdEditBtn.textContent = "修改密码";
    section.appendChild(pwdEditBtn);

    // 邮箱编辑交互
    emailEditBtn.addEventListener("click", () => {
      emailEditBtn.classList.add("hidden");
      const group = document.createElement("div");
      group.className = "profile-edit-group";
      const input = document.createElement("input");
      input.className = "profile-edit-input";
      input.type = "email";
      input.placeholder = "新邮箱";
      const actions = document.createElement("div");
      actions.className = "profile-edit-actions";
      const cancel = document.createElement("button");
      cancel.className = "account-action-btn";
      cancel.type = "button";
      cancel.textContent = "取消";
      const confirm = document.createElement("button");
      confirm.className = "account-action-btn primary";
      confirm.type = "button";
      confirm.textContent = "确认";
      cancel.addEventListener("click", () => {
        group.remove();
        emailEditBtn.classList.remove("hidden");
      });
      confirm.addEventListener("click", async () => {
        const newEmail = input.value.trim();
        if (!newEmail) return;
        confirm.disabled = true;
        try {
          const { error } = await window.VoiceBridgeAuth?.supabase.auth.updateUser({ email: newEmail });
          if (error) throw error;
          showToast("验证邮件已发送到新邮箱");
          group.remove();
          emailEditBtn.classList.remove("hidden");
        } catch (err) {
          showToast(err.message || "修改失败", true);
        } finally {
          confirm.disabled = false;
        }
      });
      actions.appendChild(cancel);
      actions.appendChild(confirm);
      group.appendChild(input);
      group.appendChild(actions);
      section.insertBefore(group, emailEditBtn.nextSibling);
      input.focus();
    });

    // 密码编辑交互
    pwdEditBtn.addEventListener("click", () => {
      pwdEditBtn.classList.add("hidden");
      const group = document.createElement("div");
      group.className = "profile-edit-group";
      const currInput = document.createElement("input");
      currInput.className = "profile-edit-input";
      currInput.type = "password";
      currInput.placeholder = "当前密码";
      const newInput = document.createElement("input");
      newInput.className = "profile-edit-input";
      newInput.type = "password";
      newInput.placeholder = "新密码（至少6位）";
      const actions = document.createElement("div");
      actions.className = "profile-edit-actions";
      const cancel = document.createElement("button");
      cancel.className = "account-action-btn";
      cancel.type = "button";
      cancel.textContent = "取消";
      const confirm = document.createElement("button");
      confirm.className = "account-action-btn primary";
      confirm.type = "button";
      confirm.textContent = "确认";
      cancel.addEventListener("click", () => {
        group.remove();
        pwdEditBtn.classList.remove("hidden");
      });
      confirm.addEventListener("click", async () => {
        const curr = currInput.value;
        const newPwd = newInput.value;
        if (!curr || !newPwd || newPwd.length < 6) {
          showToast("请填写当前密码和新密码（至少6位）", true);
          return;
        }
        confirm.disabled = true;
        try {
          const { error } = await window.VoiceBridgeAuth?.supabase.auth.updateUser({ password: newPwd });
          if (error) throw error;
          showToast("密码已修改");
          group.remove();
          pwdEditBtn.classList.remove("hidden");
        } catch (err) {
          showToast(err.message || "修改失败", true);
        } finally {
          confirm.disabled = false;
        }
      });
      actions.appendChild(cancel);
      actions.appendChild(confirm);
      group.appendChild(currInput);
      group.appendChild(newInput);
      group.appendChild(actions);
      section.insertBefore(group, pwdEditBtn.nextSibling);
      currInput.focus();
    });

    // 退出登录按钮
    const logoutBtn = document.createElement("button");
    logoutBtn.className = "account-action-btn danger";
    logoutBtn.type = "button";
    logoutBtn.textContent = "退出登录";
    logoutBtn.addEventListener("click", async () => {
      this.close();
      await window.VoiceBridgeAuth?.signOut();
    });
    section.appendChild(logoutBtn);

    return section;
  }
  _renderDevices(data) {
    const section = document.createElement("div");
    section.className = "account-section";

    const title = document.createElement("p");
    title.className = "account-section-title";
    title.textContent = "已连接设备";
    section.appendChild(title);

    if (!data.devices.length) {
      const hint = document.createElement("p");
      hint.style.cssText = "margin:0;font-size:13px;color:var(--text-muted)";
      hint.textContent = "暂无已注册设备";
      section.appendChild(hint);
      return section;
    }

    const now = Date.now();
    for (const device of data.devices) {
      const item = document.createElement("div");
      item.className = "device-item";

      const lastSeen = device.last_seen_at ? new Date(device.last_seen_at) : null;
      const isOnline = lastSeen && (now - lastSeen.getTime()) < 120_000;

      const dot = document.createElement("span");
      dot.className = `device-status-dot ${isOnline ? "online" : ""}`;
      item.appendChild(dot);

      const info = document.createElement("div");
      info.className = "device-info";
      const name = document.createElement("p");
      name.className = "device-name";
      name.textContent = device.device_name || device.platform || "未知设备";
      info.appendChild(name);
      const seen = document.createElement("p");
      seen.className = "device-last-seen";
      seen.textContent = lastSeen ? formatRelativeTime(now - lastSeen.getTime()) : "未知";
      info.appendChild(seen);
      item.appendChild(info);

      const removeBtn = document.createElement("button");
      removeBtn.className = "device-remove-btn";
      removeBtn.type = "button";
      removeBtn.textContent = "移除";
      removeBtn.addEventListener("click", async () => {
        if (removeBtn.textContent === "移除") {
          removeBtn.textContent = "确认？";
          setTimeout(() => { removeBtn.textContent = "移除"; }, 3000);
          return;
        }
        removeBtn.disabled = true;
        try {
          const { error } = await window.VoiceBridgeAuth?.supabase
            .from("devices").delete().eq("id", device.id);
          if (error) throw error;
          item.remove();
          if (!section.querySelector(".device-item")) {
            section.innerHTML = "<p style='margin:0;font-size:13px;color:var(--text-muted)'>暂无已注册设备</p>";
          }
        } catch (err) {
          showToast(err.message || "移除失败", true);
          removeBtn.disabled = false;
        }
      });
      item.appendChild(removeBtn);

      section.appendChild(item);
    }

    return section;
  }
}

const accountDrawer = new AccountDrawer();
accountDrawerBtn?.addEventListener("click", () => accountDrawer.open());
