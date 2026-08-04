import { CloudRealtime, getPhoneDeviceId, isDesktopDeviceCandidate } from "./cloudRealtime.js";
import { createBillingSession } from "./billing.js";
import { recordWavUntilStopped } from "./cloudRecorder.js";
import { transcribeCloudAudio } from "./cloudTranscribe.js";
import { commandStore } from "./commandStore.js";
import { isProtocolCompatible } from "./shared/protocol.js";
import { PLAN_LIMITS, getPlanLimit, isAdminPlan } from "./shared/planLimits.js";
import { t, getAvailableLocales, setLocale, getCurrentLocale, getIntlLocale } from "./i18n/i18n.js";

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
const lanCommandStore = {
  list: () => requestLanCommands("/api/commands"),
  create: (command) => requestLanCommands("/api/commands", {
    method: "POST",
    body: JSON.stringify(command)
  }),
  update: (id, updates) => requestLanCommands(`/api/commands/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(updates)
  }),
  remove: (id) => requestLanCommands(`/api/commands/${encodeURIComponent(id)}`, {
    method: "DELETE"
  })
};
const activeCommandStore = isCloudMode ? commandStore : lanCommandStore;
let cloudRealtime = null;
let selectedCloudDeviceId = "";
let cloudDesktopDevices = [];
let activeCloudUserId = "";
let activeCloudPhoneDeviceId = "";

async function requestLanCommands(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || t('commandStore.operationFailed'));
  if (Array.isArray(payload)) {
    return payload.map((command) => ({
      ...command,
      source: "user",
      requiredPlan: "free",
      locked: false
    }));
  }
  return { ...payload, source: "user", requiredPlan: "free", locked: false };
}

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
  btn.textContent = t('common.copyToPhone');
  btn.addEventListener("click", () => {
    copyToPhoneClipboard(copyText);
    btn.disabled = true;
    btn.textContent = t('common.copied');
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
  const labelKeys = {
    connected: "device.statusConnected",
    error: "device.statusDisconnected",
    connecting: "device.statusConnecting"
  };
  statusBadge.className = "status-badge " + state;
  statusBadge.textContent = t(labelKeys[state] || "device.statusConnecting");
}

statusDot.addEventListener("click", () => {
  showToast(statusDot.title);
});

pageRefreshButton?.addEventListener("click", () => {
  if (pageRefreshButton.classList.contains("is-reloading")) return;
  pageRefreshButton.classList.add("is-reloading");
  setTimeout(() => location.reload(), 600);
});

// AutoPaste 开关切换时，重新计算发送按钮的显隐
autoPasteEl?.addEventListener("change", () => {
  updateTextInputState();
});

// === Text Input ===
function updateTextInputState() {
  const text = textInput.value.trim();
  if (charCount) charCount.textContent = t('input.charCount', textInput.value.length, 2000);
  const saveBtn = document.querySelector("#savePhraseBtn");
  const sendBtn = document.querySelector("#sendTextBtn");

  // In edit mode, hide save/send buttons — handled by edit UI
  if (commandLibrary.editingId) {
    saveBtn.classList.add("hidden");
    sendBtn.classList.add("hidden");
    commandLibrary._checkEditChanges();
    return;
  }

  if (text) {
    saveBtn.classList.remove("hidden");
    saveBtn.classList.remove("saved");
    saveBtn.innerHTML = starSvg + " " + t('input.savePhrase');
    // 仅 AutoPaste 关闭时才需要手动发送按钮
    if (autoPasteEl && !autoPasteEl.checked) {
      sendBtn.classList.remove("hidden");
    } else {
      sendBtn.classList.add("hidden");
    }
  } else {
    saveBtn.classList.add("hidden");
    sendBtn.classList.add("hidden");
  }
}

let lastAutoPastedText = "";
let lastAutoPasteTimer = null;

async function sendTextInput() {
  const text = textInput.value.trim();
  if (!text) return;
  if (text.length > 2000) {
    showToast(t('input.textTooLong'), true);
    return;
  }
  if (text === lastAutoPastedText) {
    textInput.value = "";
    updateTextInputState();
    lastAutoPastedText = "";
    clearTimeout(lastAutoPasteTimer);
    lastAutoPasteTimer = null;
    showToast(t('input.autoSentNotice'));
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

async function sendTextToDesktop(text, { localSuccessMessage = t('status.sentToDesktop') } = {}) {
  if ((window.__VB_CONFIG || {}).voicebridgeMode === "cloud") {
    if (!cloudRealtime || !selectedCloudDeviceId) {
      showToast(t('status.desktopNotOpen'), true);
      return false;
    }
    if (!selectedCloudDeviceIsCompatible()) return false;
    try {
      const sendPromise = cloudRealtime.sendText({
        targetDeviceId: selectedCloudDeviceId,
        text,
        // 手动点"发送"按钮的意图是把文本输入到光标处，不是只入剪贴板。
        // 所以无论 autoPaste 开关状态如何，都强制为 true。
        autoPaste: true,
        targetWindowId: windowSelector.targetWindow?.windowId
      });
      showToast(t('status.sending'));
      await sendPromise;
      return true;
    } catch (error) {
      showToast(error.message || t('connection.sendFailed'), true);
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
    showToast(t('status.sendFailedConnection'), true);
    return false;
  }
}

async function handleAuthState(event) {
  const { session, user } = event.detail;
  updateBillingControls(Boolean(session));
  if (!isCloudMode) return;
  if (!session || !user || !window.VoiceBridgeAuth?.supabase) {
    if (activeCloudUserId) {
      showToast(t('status.sessionExpired'));
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

  // 登记/刷新手机端自己的设备记录，使 Realtime RLS policy 能通过
  // （policy 要求订阅 device:<user_id>:<device_id> 时 devices 表里有对应行）
  try {
    const sbAuth = window.VoiceBridgeAuth?.supabase;
    if (sbAuth) {
      await sbAuth.from("devices").upsert({
        id: phoneDeviceId,
        user_id: user.id,
        runtime_user_id: user.id,
        name: "Phone",
        device_type: "phone",
        platform: "web",
        app_version: navigator.userAgent,
        status: "active",
        last_seen_at: new Date().toISOString()
      }, { onConflict: "id" });
    }
  } catch (error) {
    console.warn("Failed to register phone device:", error);
  }

  const realtime = new CloudRealtime({
    supabase: window.VoiceBridgeAuth.supabase,
    user,
    phoneDeviceId,
    onDevices: (devices) => {
      const desktopDevices = devices.filter((device) => isDesktopDeviceCandidate(device, phoneDeviceId));
      renderCloudDeviceOptions(desktopDevices);
    },
    onAck: (ack) => {
      if (ack.key) return;
      showToast(ack.status === "success" ? t('status.sentToDesktopAck') : t('status.desktopExecFailed', ack.detail));
    },
    onStatus: () => setConnectionStatus("connected", t('connection.cloudConnected'))
  });
  cloudRealtime = realtime;
  // 更新 plan badge
  const sb = window.VoiceBridgeAuth?.supabase;
  if (sb && planBadge) {
    sb.from("subscriptions").select("plan,status").eq("user_id", user.id).maybeSingle()
      .then(({ data: sub }) => {
        const plan = sub?.plan === "admin"
          ? "admin"
          : (sub?.plan === "pro" && isPaidStatus(sub.status) ? "pro" : "free");
        currentUserPlan = plan;
        if (plan === "admin") {
          planBadge.textContent = t('planBadge.admin');
          planBadge.classList.remove("pro");
          planBadge.classList.add("admin");
        } else {
          planBadge.textContent = plan === "pro" ? t('planBadge.pro') : t('planBadge.free');
          planBadge.classList.remove("admin");
          planBadge.classList.toggle("pro", plan === "pro");
        }
      })
      .catch(() => {});
  }
  try {
    await realtime.start();
  } catch (error) {
    if (cloudRealtime !== realtime || activeCloudUserId !== user.id || activeCloudPhoneDeviceId !== phoneDeviceId) {
      return;
    }
    showToast(error.message || t('connection.cloudConnectFailedToast'), true);
    setConnectionStatus("error", t('connection.cloudConnectFailed'));
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
  syncDeviceSelectorLabel();
});

// === 设备/窗口两行折叠交互 ===
const deviceRowPrimary = document.querySelector("#deviceRowPrimary");
const deviceRowExpand = document.querySelector("#deviceRowExpand");

function isDeviceRowExpanded() {
  return deviceRowPrimary?.classList.contains("is-expanded");
}

function setDeviceRowExpanded(expanded) {
  if (!deviceRowPrimary || !deviceRowExpand) return;
  deviceRowPrimary.classList.toggle("is-expanded", expanded);
  deviceRowExpand.classList.toggle("hidden", !expanded);
}

// 第一行任意空白点击均可展开/收起；但点击内部控件（按钮/输入）不触发
deviceRowPrimary?.addEventListener("click", (event) => {
  if (event.target.closest("button,input,label,.toggle-switch")) return;
  setDeviceRowExpanded(!isDeviceRowExpanded());
});

// === 自定义设备下拉 ===
const deviceSelectorBtn = document.querySelector("#deviceSelectorBtn");
const deviceSelectorDropdown = document.querySelector("#deviceSelectorDropdown");
const deviceSelectorList = document.querySelector("#deviceSelectorList");
const deviceSelectorLabel = document.querySelector("#deviceSelectorLabel");

function isDeviceSelectorOpen() {
  return !deviceSelectorDropdown?.classList.contains("hidden");
}

function setDeviceSelectorOpen(open) {
  if (!deviceSelectorDropdown || !deviceSelectorBtn) return;
  deviceSelectorDropdown.classList.toggle("hidden", !open);
  deviceSelectorBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function syncDeviceSelectorLabel() {
  if (!deviceSelectorLabel || !cloudDeviceSelect) return;
  const value = cloudDeviceSelect.value;
  if (!value) {
    deviceSelectorLabel.textContent = t('device.device');
    return;
  }
  const opt = Array.from(cloudDeviceSelect.options).find((o) => o.value === value);
  deviceSelectorLabel.textContent = opt?.textContent || value;
}

deviceSelectorBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  setDeviceSelectorOpen(!isDeviceSelectorOpen());
});

document.addEventListener("click", (event) => {
  if (isDeviceSelectorOpen() && !deviceSelectorDropdown?.contains(event.target) && event.target !== deviceSelectorBtn) {
    setDeviceSelectorOpen(false);
  }
});

function renderCloudDeviceOptions(desktopDevices) {
  cloudDesktopDevices = desktopDevices;
  const previousDeviceId = selectedCloudDeviceId;
  const options = desktopDevices.length
    ? desktopDevices.map((device) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      const name = device.name || device.deviceId;
      option.textContent = isProtocolCompatible(device.protocolVersion) ? name : t('libraryExtra.needUpdate', name);
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

  renderDeviceSelectorList(desktopDevices);
  syncDeviceSelectorLabel();
}

function renderDeviceSelectorList(desktopDevices) {
  if (!deviceSelectorList) return;
  deviceSelectorList.replaceChildren();
  if (!desktopDevices.length) {
    const p = document.createElement("p");
    p.className = "window-list-loading";
    p.textContent = t('device.waitingDesktop');
    deviceSelectorList.appendChild(p);
    return;
  }
  for (const device of desktopDevices) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "window-list-item";
    btn.dataset.deviceId = device.deviceId;
    const name = device.name || device.deviceId;
    btn.textContent = isProtocolCompatible(device.protocolVersion) ? name : t('libraryExtra.needUpdate', name);
    btn.addEventListener("click", () => {
      selectedCloudDeviceId = device.deviceId;
      cloudDeviceSelect.value = device.deviceId;
      syncDeviceSelectorLabel();
      setDeviceSelectorOpen(false);
    });
    deviceSelectorList.appendChild(btn);
  }
}

function createCloudPlaceholderOption() {
  const option = document.createElement("option");
  option.value = "";
  option.textContent = t('device.waitingDesktop');
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
  cloudDesktopDevices = [];
  cloudDeviceSelect.replaceChildren(createCloudPlaceholderOption());
  if (deviceSelectorList) {
    deviceSelectorList.replaceChildren();
    const p = document.createElement("p");
    p.className = "window-list-loading";
    p.textContent = t('device.waitingDesktop');
    deviceSelectorList.appendChild(p);
  }
  syncDeviceSelectorLabel?.();
}

function isPaidStatus(status) {
  return status === "active" || status === "trialing";
}

let currentUserPlan = "free";  // updated by handleAuthState subscription query

function formatRelativeTime(diffMs) {
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.daysAgo', days);
  return t('time.monthsAgo', Math.floor(days / 30));
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
    // If backend returned a transactionId, use Paddle.js overlay checkout
    if (payload.transactionId) {
      const paddle = await loadPaddleJS();
      paddle.Checkout.open({
        transactionId: payload.transactionId,
        settings: {
          successUrl: window.location.origin + "/app?billing=success",
          theme: "light",
        },
      });
      button.disabled = false;
    } else {
      location.href = payload.url;
    }
  } catch (error) {
    showToast(error.message || t('billing.subscriptionRequestFailed'), true);
    button.disabled = false;
  }
}

// Lazy-load Paddle.js SDK (sandbox or production based on hostname)
let paddlePromise = null;
function loadPaddleJS() {
  if (paddlePromise) return paddlePromise;
  paddlePromise = new Promise((resolve, reject) => {
    if (window.Paddle) {
      resolve(window.Paddle);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
    script.onload = () => {
      const isSandbox = location.hostname.includes("pages.dev") ||
                        location.hostname === "localhost" ||
                        location.hostname === "127.0.0.1";
      if (isSandbox) {
        window.Paddle.Environment.set("sandbox");
      }
      window.Paddle.Initialize({
        token: window.__VB_CONFIG?.paddleClientToken || "",
      });
      resolve(window.Paddle);
    };
    script.onerror = () => reject(new Error("Failed to load Paddle.js"));
    document.head.appendChild(script);
  });
  return paddlePromise;
}

updateBillingControls(Boolean(window.VoiceBridgeAuth?.session));

// === Billing Callback ===
(function handleBillingCallback() {
  const params = new URLSearchParams(location.search);
  const billing = params.get("billing");
  if (billing === "success") {
    history.replaceState(null, "", location.pathname);
    pollSubscriptionActivation();
  } else if (billing === "cancel") {
    showToast(t('billing.subscribeCanceled'));
    history.replaceState(null, "", location.pathname);
  }
})();

// 支付成功后轮询订阅状态，等 Webhook 同步后显示激活成功
function pollSubscriptionActivation() {
  const sb = window.VoiceBridgeAuth?.supabase;
  if (!sb) {
    showToast(t('billing.subscribeSuccess'));
    return;
  }
  const user = window.VoiceBridgeAuth?.user;
  if (!user?.id) {
    showToast(t('billing.subscribeSuccess'));
    return;
  }

  showToast(t('billing.activating'));
  const maxAttempts = 10;
  const intervalMs = 3000;
  let attempts = 0;

  const poll = async () => {
    attempts++;
    try {
      const { data: sub } = await sb
        .from("subscriptions")
        .select("plan,status")
        .eq("user_id", user.id)
        .maybeSingle();
      if (sub?.plan === "pro" && ["active", "trialing"].includes(sub.status)) {
        showToast(t('billing.subscribeSuccess'));
        location.reload();
        return;
      }
    } catch (e) {
      // 忽略查询错误，继续轮询
    }
    if (attempts >= maxAttempts) {
      showToast(t('billing.activatingTimeout'), true);
      return;
    }
    setTimeout(poll, intervalMs);
  };
  setTimeout(poll, intervalMs);
}

// === SVG Icons ===
const starSvg = '<svg viewBox="0 0 24 24" width="14" height="14"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// === Record Button ===
const recordButton = document.querySelector("#recordButton");
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

  get targetWindow() {
    if (isCloudMode && this.selectedWindow?.deviceId !== selectedCloudDeviceId) return null;
    return this.selectedWindow;
  }

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
  _open() {
    this._isOpen = true;
    const btnRect = this.el.btn.getBoundingClientRect();
    this.el.dropdown.style.top = (btnRect.bottom + 12) + "px";
    this.el.dropdown.classList.remove("hidden");
    this.el.btn.setAttribute("aria-expanded", "true");
    this._fetchWindows();
  }
  _close() {
    this._isOpen = false;
    this.el.dropdown.classList.add("hidden");
    this.el.dropdown.style.top = "";
    this.el.btn.setAttribute("aria-expanded", "false");
  }

  _updateButton() {
    if (this.selectedWindow) {
      this.el.btnLabel.textContent = this.selectedWindow.appName;
      this.el.btn.classList.add("active");
    } else {
      this.el.btnLabel.textContent = t('device.cursorPosition');
      this.el.btn.classList.remove("active");
    }
  }

  async _fetchWindows() {
    if (isCloudMode) {
      const windows = cloudDesktopDevices
        .find((device) => device.deviceId === selectedCloudDeviceId)
        ?.windows || [];
      this._renderCloudWindows(windows);
      return;
    }
    const now = Date.now();
    if (this._windowCache && now - this._windowCacheTime < 5000) {
      this._renderWindows(this._windowCache);
      return;
    }
    this.el.list.innerHTML = `<p class="window-list-loading">${t('common.loading')}</p>`;
    try {
      const res = await fetch("/api/windows");
      if (!res.ok) {
        console.error("API error:", res.status, await res.text().catch(() => ""));
        this.el.list.innerHTML = `<p class="window-list-empty">${t('windowSelector.fetchFailed')}</p>`;
        return;
      }
      const data = await res.json();
      if (!data.ok || !data.windows || data.windows.length === 0) {
        this.el.list.innerHTML = `<p class="window-list-empty">${t('windowSelector.noWindows')}</p>`;
        return;
      }
      this._renderWindows(data.windows);
      this._windowCache = data.windows;
      this._windowCacheTime = Date.now();
    } catch {
      this.el.list.innerHTML = `<p class="window-list-empty">${t('windowSelector.fetchFailed')}</p>`;
    }
  }

  _renderWindows(groups) {
    this.el.list.innerHTML = "";
    // 固定选项：光标位置（始终在最顶部）
    const cursorBtn = document.createElement("button");
    cursorBtn.className = "window-item";
    cursorBtn.type = "button";
    const cursorSelected = !this.selectedWindow;
    if (cursorSelected) cursorBtn.classList.add("selected");
    cursorBtn.setAttribute("aria-selected", String(cursorSelected));
    const cursorCheck = document.createElement("span");
    cursorCheck.className = "window-item-check";
    cursorCheck.textContent = cursorSelected ? "✓" : "";
    cursorBtn.appendChild(cursorCheck);
    const cursorTitle = document.createElement("span");
    cursorTitle.className = "window-item-title";
    cursorTitle.textContent = t('device.cursorPosition');
    cursorBtn.appendChild(cursorTitle);
    cursorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectedWindow = null;
      this._saveSelection();
      this._updateButton();
      this._close();
    });
    this.el.list.appendChild(cursorBtn);
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

  _renderCloudWindows(windows) {
    this.el.list.replaceChildren();
    const cursorBtn = this._createCloudWindowButton(null, t('windowSelector.cursorPosition'));
    this.el.list.appendChild(cursorBtn);
    for (const win of windows) {
      this.el.list.appendChild(this._createCloudWindowButton(
        win,
        win.title || win.app || t('windowSelector.defaultWindowName')
      ));
    }
    if (!windows.length) {
      const empty = document.createElement("p");
      empty.className = "window-list-empty";
      empty.textContent = t('windowSelector.noWindowsReported');
      this.el.list.appendChild(empty);
    }
  }

  _createCloudWindowButton(win, label) {
    const btn = document.createElement("button");
    btn.className = "window-item";
    btn.type = "button";
    const isSelected = win
      ? this.selectedWindow?.windowId === win.windowId
      : !this.selectedWindow;
    if (isSelected) btn.classList.add("selected");
    btn.setAttribute("aria-selected", String(isSelected));
    const check = document.createElement("span");
    check.className = "window-item-check";
    check.textContent = isSelected ? "✓" : "";
    const title = document.createElement("span");
    title.className = "window-item-title";
    title.textContent = label;
    btn.append(check, title);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.selectedWindow = win
        ? {
            windowId: win.windowId,
            appName: win.app,
            title: win.title || null,
            deviceId: selectedCloudDeviceId
          }
        : null;
      this._saveSelection();
      this._updateButton();
      this._close();
    });
    return btn;
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
    this.activeCategory = t('libraryExtra.recent');
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

    this.container.addEventListener("click", async (e) => {
      // Command button click — disabled during edit mode
      const btn = e.target.closest(".cmd-btn");
      if (!btn) return;
      if (this.editingId) return;
      const id = btn.dataset.id;
      const cmd = this.commands.find(c => c.id === id);
      if (!cmd) return;
      if (cmd.locked) {
        showToast(t('library.lockedTip'), true);
        return;
      }
      sendQuickCommand(cmd.text, cmd.label);
      this.touchCommand(id);
    });
    // Long press for edit mode
    this.container.addEventListener("pointerdown", (e) => {
      const btn = e.target.closest(".cmd-btn");
      if (!btn || this.editingId) return;
      const id = btn.dataset.id;
      const cmd = this.commands.find(c => c.id === id);
      if (!cmd || cmd.source !== "user" || cmd.locked) return;
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
      this.commands = await activeCommandStore.list();
      // If "最近" is active but no commands have been used, fall back to first category
      if (this.activeCategory === t('libraryExtra.recent') && !this.commands.some(c => c.lastUsedAt)) {
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
      this.container.innerHTML = `<p style="padding:12px;color:var(--text-muted);text-align:center;">${t('library.loadFailed')}</p>`;
    }
  }

  _getCategories() {
    const map = {};
    this.commands.forEach(cmd => {
      const cat = cmd.category || t('libraryExtra.uncategorized');
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
      recentBtn.className = "tab-item" + (this.activeCategory === t('libraryExtra.recent') ? " active" : "");
      recentBtn.type = "button";
      recentBtn.setAttribute("role", "tab");
      recentBtn.setAttribute("aria-selected", String(this.activeCategory === t('libraryExtra.recent')));
      recentBtn.dataset.category = t('libraryExtra.recent');
      const recentNameSpan = document.createElement("span");
      recentNameSpan.textContent = t('libraryExtra.recent');
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
      this.container.innerHTML = `<p style="padding:12px;color:var(--text-muted);text-align:center;">${t('library.empty')}</p>`;
      return;
    }

    // When searching, show results across all categories
    let cmdsToShow;
    if (q) {
      cmdsToShow = this.commands.filter(c => (c.label || "").toLowerCase().includes(q) || (c.text || "").toLowerCase().includes(q));
    } else if (this.activeCategory === t('libraryExtra.recent')) {
      // Show recently used commands across all categories, deduplicated, sorted by lastUsedAt desc, max 16
      const seen = new Set();
      cmdsToShow = this.commands
        .filter(c => c.lastUsedAt && !/^[──\-]{2,}/.test(c.label) && !seen.has(c.id) && (seen.add(c.id), true))
        .sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0))
        .slice(0, 16);
    } else {
      cmdsToShow = this.commands.filter(c => (c.category || t('libraryExtra.uncategorized')) === this.activeCategory);
    }

    // Sort by lastUsedAt only for "最近" and search
    if (q || this.activeCategory === t('libraryExtra.recent')) {
      cmdsToShow.sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0));
    }

    if (cmdsToShow.length === 0) {
      this.container.innerHTML = `<p style="padding:12px;color:var(--text-muted);text-align:center;">${t('library.noMatch')}</p>`;
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
      if (cmd.locked) {
        btn.classList.add("is-locked");
        btn.setAttribute("aria-disabled", "true");
        btn.title = t('library.lockedTooltip');
      }
      if (cmd.text.startsWith("/") || /^(npm|node|copyclaw|npx)\b/.test(cmd.text)) {
        btn.classList.add("slash");
      }
      if (this.editingId) btn.classList.add("dimmed");
      const labelSpan = document.createElement("span");
      labelSpan.className = "cmd-label";
      labelSpan.textContent = cmd.label;
      btn.appendChild(labelSpan);
      if (cmd.locked) {
        const lock = document.createElement("span");
        lock.className = "cmd-lock";
        lock.textContent = "Pro";
        btn.appendChild(lock);
      }
      grid.appendChild(btn);
    });
    this.container.appendChild(grid);
  }

  _enterEditMode(id) {
    const cmd = this.commands.find(c => c.id === id);
    if (!cmd) return;
    if (cmd.source !== "user" || cmd.locked) {
      showToast(cmd.locked ? t('libraryExtra.lockedEdit') : t('libraryExtra.presetNonEditable'), true);
      return;
    }
    this.editingId = id;

    // Populate input area
    const editLabel = document.getElementById("editLabelInput");
    const inputCard = document.getElementById("inputCard");
    editLabel.value = cmd.label;
    editLabel.classList.remove("hidden");
    textInput.value = cmd.text;
    textInput.rows = 5;
    textInput.placeholder = t('libraryExtra.editPlaceholder');
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
        showToast(t('library.saved'));
      }
    }

    // Restore input area
    const editLabel = document.getElementById("editLabelInput");
    const inputCard = document.getElementById("inputCard");
    editLabel.value = "";
    editLabel.classList.add("hidden");
    textInput.value = "";
    textInput.rows = 3;
    textInput.placeholder = t('input.placeholder');
    inputCard.classList.remove("editing");

    // Hide edit buttons
    document.getElementById("editDeleteBtn").classList.add("hidden");
    document.getElementById("editSaveBtn").classList.add("hidden");
    document.getElementById("editCancelBtn").classList.add("hidden");

    // Re-enable primary actions
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
      await activeCommandStore.remove(id);
      this.commands = this.commands.filter(c => c.id !== id);
      showToast(t('library.deleted'));
      this._exitEditMode(false);
    } catch {
      showToast(t('library.deleteFailed'), true);
      this._exitEditMode(false);
    }
  }

  async _updateCommand(id, updates) {
    try {
      const updated = await activeCommandStore.update(id, updates);
      const idx = this.commands.findIndex(c => c.id === id);
      if (idx !== -1) this.commands[idx] = updated;
    } catch (err) {
      console.error("commandStore.update failed:", err);
    }
  }

  async touchCommand(id) {
    const command = this.commands.find(c => c.id === id);
    if (!command || command.source !== "user") return;
    try {
      const updated = await activeCommandStore.update(id, { lastUsedAt: Date.now() });
      const idx = this.commands.findIndex(c => c.id === id);
      if (idx !== -1) this.commands[idx] = updated;
      this.renderTabs();
      this.render();
    } catch (err) {
      console.error("commandStore.update (touch) failed:", err);
    }
  }

  async addCommand(text, category) {
    try {
      const created = await activeCommandStore.create({
        text,
        label: text.length > 8 ? text.slice(0, 8) + "\u2026" : text,
        category: category || t('library.categoryGeneral')
      });
      this.commands.unshift(created);
      // Switch to the category of the newly added command
      this.activeCategory = created.category || t('libraryExtra.uncategorized');
      this.renderTabs();
      this.render();
      showToast(t('libraryExtra.addedSuccess'));
    } catch {
      showToast(t('libraryExtra.addFailed'), true);
    }
  }

  getUniqueCategories() {
    return new Set(this.commands.map(c => c.category || t('libraryExtra.uncategorized')));
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
    newOpt.textContent = t('common.newCategory');
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
      ? (newCatInput.value.trim() || t('library.categoryGeneral'))
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
          await activeCommandStore.create({
            text: phrase.text,
            label: phrase.text.length > 8 ? phrase.text.slice(0, 8) + "\u2026" : phrase.text,
            category: t('library.categoryGeneral'),
          });
        }
      }
      localStorage.setItem(migratedKey, "true");
      this.commands = await activeCommandStore.list();
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
  updateTextInputState();
});

textInput.addEventListener("keydown", (e) => {
  if (commandLibrary.editingId) {
    if (e.key === "Escape") { e.preventDefault(); commandLibrary._exitEditMode(false); }
    return;
  }
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

function sendKeyCommand(key, successMessage) {
  if (isCloudMode) {
    if (!cloudRealtime || !selectedCloudDeviceId) {
      showToast(t('status.desktopNotOpen'), true);
      return;
    }
    if (!selectedCloudDeviceIsCompatible()) return;
    showToast(t('status.sending'));
    cloudRealtime.sendKey({
      targetDeviceId: selectedCloudDeviceId,
      key,
      targetWindowId: windowSelector.targetWindow?.windowId
    })
      .then(() => showToast(successMessage))
      .catch((error) => showToast(error.message || t('status.sendFailed'), true));
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "key", key }));
    showToast(successMessage);
  } else {
    showToast(t('status.sendFailedConnection'), true);
  }
}

function selectedCloudDeviceIsCompatible() {
  const device = cloudDesktopDevices.find(({ deviceId }) => deviceId === selectedCloudDeviceId);
  if (device && isProtocolCompatible(device.protocolVersion)) return true;
  showToast(t('status.protocolTooOld'), true);
  return false;
}

pasteButton.addEventListener("click", () => {
  sendKeyCommand("paste", t('record.pasteKeySuccess'));
});

undoButton.addEventListener("click", () => {
  sendKeyCommand("undo", t('record.undoKeySuccess'));
});

escButton.addEventListener("click", () => {
  sendKeyCommand("escape", t('record.escKeySuccess'));
});

deleteButton.addEventListener("click", () => {
  sendKeyCommand("delete", t('record.deleteKeySuccess'));
});

async function sendQuickCommand(text, label) {
  await sendTextToDesktop(text, { localSuccessMessage: t('record.quickCmdSent') });
}

// === Action Buttons ===
enterButton.addEventListener("click", () => {
  sendKeyCommand("enter", t('record.enterKeySuccess'));
});

// === Save / Add Command Button ===
const savePhraseBtn = document.querySelector("#savePhraseBtn");
savePhraseBtn.addEventListener("click", () => {
  const text = textInput.value.trim();
  if (text) {
    commandLibrary.openAddDialog(text);
  }
});

// === Send Text Button (AutoPaste OFF 时手动发送文本框内容) ===
const sendTextBtn = document.querySelector("#sendTextBtn");
sendTextBtn?.addEventListener("click", async () => {
  const text = textInput.value.trim();
  if (!text) return;
  sendTextBtn.disabled = true;
  const accepted = await sendTextToDesktop(text);
  sendTextBtn.disabled = false;
  if (accepted) {
    textInput.value = "";
    updateTextInputState();
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
  enterButton.disabled = disabled;
  pasteButton.disabled = disabled;
  undoButton.disabled = disabled;
  escButton.disabled = disabled;
  deleteButton.disabled = disabled;
}

if (!navigator.mediaDevices?.getUserMedia || (isCloudMode ? !BrowserAudioContext : !window.MediaRecorder)) {
  showToast(t('record.recordUnsupported'), true);
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
  labelEl.textContent = t('record.recordLabel');
}

function setRecordActive() {
  iconEl.className = "record-icon record-icon-stop";
  iconEl.innerHTML = stopSvg;
  labelEl.textContent = t('record.stopLabel');
}

function setRecordProcessing() {
  iconEl.className = "record-icon record-icon-mic";
  iconEl.innerHTML = micSvg;
  labelEl.textContent = "";
}

function currentMaxAudioMs() {
  return getPlanLimit(currentUserPlan).maxAudioMs;
}

function beginRecordingState() {
  isRecording = true;
  recordSeconds = 0;
  recordingStartedAt = performance.now();
  currentRecordingDurationMs = null;
  recordButton.classList.add("recording");
  setRecordActive();
  setActionButtonsDisabled(true);
  setConnectionStatus(statusDot.className.includes("connected") ? "connected" : "connecting", t('record.recording'));

  const maxMs = currentMaxAudioMs();
  const maxSeconds = Math.floor(maxMs / 1000);
  maxRecordTimer = setTimeout(() => {
    if (isRecording) {
      void stopRecording().catch((error) => {
        console.error("Failed to stop recording:", error);
        showToast(error.message || t('record.recordingFailed'), true);
        finishUpload();
      });
      showToast(t('record.reachedLimit', maxSeconds));
    }
  }, maxMs - 500);  // stop 500ms before hard cap so the recorder doesn't overshoot

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
      const maxMs = currentMaxAudioMs();
      recorder = await recordWavUntilStopped({
        onStopReady: async (blob) => uploadAudio(blob, "wav"),
        maxDurationMs: maxMs,
        onMaxDurationReached: () => {
          void stopRecording().catch((error) => {
            console.error("Auto-stop failed:", error);
            finishUpload();
          });
        }
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
    showToast(t('record.micDenied', error.message), true);
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
  showToast(t('record.uploading'));
  if (isCloudMode && typeof recorder.stop === "function") {
    try {
      await recorder.stop();
    } catch (error) {
      showToast(error.message || t('record.stopFailed'), true);
      finishUpload();
    }
    return;
  }
  recorder.stop();
}

async function uploadAudio(blob, extension) {
  let timeout = null;
  try {
    if (!blob.size) { showToast(t('record.noVoice'), true); finishUpload(); return; }
    showToast(t('record.recognizing'));
    if (isCloudMode) {
      const payload = await transcribeCloudAudio({
        audio: blob,
        filename: `voicebridge.${extension}`,
        durationMs: currentRecordingDurationMs
      });
      const text = (payload.text || "").trim();
      if (!text) throw new Error(t('record.noTranscriptText'));
      // 识别结果先放入文本框（与 Lan 版本对齐：可见、可编辑、可收藏）
      if (!commandLibrary.editingId) {
        textInput.value = text;
        updateTextInputState();
      }
      // 仅 AutoPaste ON 时立即异步发送（延迟与原实现相同，void 表示不 await）
      if (autoPasteEl.checked) {
        void sendTextToDesktop(text).catch((error) => {
          showToast(error.message || t('connection.sendFailed'), true);
        });
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
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch("/api/upload", { method: "POST", body: formData, signal: controller.signal });
    clearTimeout(timeout);
    timeout = null;
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || t('record.uploadFailed'));
    const output = payload.output || {};
    if (output.buffered) {
      showToast(t('record.appendedToBuffer'));
    } else if (output.command) {
      showToast(output.keyError ? t('record.voiceCommandFailed') : t('record.voiceCommandExecuted'), Boolean(output.keyError));
    } else if (output.pasted) {
      showToast(t('record.copiedAndPasted'));
    } else if (output.copied) {
      showCopyToast(t('record.copiedToClipboard'), payload.text || "");
    } else {
      showToast(t('record.clipboardFailed'), true);
    }
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    if (error.name === "AbortError") {
      showToast(t('record.uploadTimeout'), true);
      return;
    }
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
    setConnectionStatus("connected", t('connection.wsConnected'));
  });
  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "result" && payload.text) {
        if (!commandLibrary.editingId) {
          textInput.value = payload.text;
          updateTextInputState();
        }
      }
      if (payload.message) {
        showToast(payload.message, payload.type === "error");
      }
      if (payload.type === "output") {
        if (payload.buffered) {
          showToast(t('record.appendedToBuffer'));
        } else if (payload.command) {
          showToast(payload.keyError ? t('record.voiceCommandFailed') : t('record.voiceCommandExecuted'), Boolean(payload.keyError));
        } else if (!payload.copied) {
          showToast(t('record.clipboardFailed'), true);
        } else if (!payload.pasted) {
          if (payload.pasteError) {
            showToast(t('record.pasteAutoFailed'), true);
          } else if (payload.text) {
            showCopyToast(t('record.copiedToClipboardShort'), payload.text);
          }
        }
      }
    } catch {
      // Ignore malformed messages
    }
  });
  ws.addEventListener("close", (event) => {
    if (event.code === 1000) return; // Normal closure, no reconnect
    setConnectionStatus("error", t('connection.reconnecting'));
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
    body.innerHTML = `<p style='text-align:center;color:var(--text-muted)'>${t('common.loading')}</p>`;
    try {
      const data = await this._fetchData();
      body.replaceChildren(
        this._renderLanguage(),
        this._renderPlan(data),
        this._renderPricing(data),
        this._renderUsage(data),
        this._renderSubscription(data),
        this._renderProfile(data),
        this._renderDevices(data),
      );
    } catch (error) {
      const errP = document.createElement("p");
      errP.style.cssText = "text-align:center;color:var(--danger)";
      errP.textContent = error.message || t('account.loadFailed');
      body.replaceChildren(errP);
    }
  }

  _renderLanguage() {
    const section = document.createElement("div");
    section.className = "account-section";

    const title = document.createElement("p");
    title.className = "account-section-title";
    title.textContent = t('account.languageTitle');
    section.appendChild(title);

    const row = document.createElement("div");
    row.className = "account-row";
    const select = document.createElement("select");
    select.className = "profile-edit-input";
    select.style.marginTop = "0";
    for (const { code, label } of getAvailableLocales()) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = label;
      if (code === getCurrentLocale()) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => setLocale(select.value));
    row.appendChild(select);
    section.appendChild(row);
    return section;
  }

  async _fetchData() {
    const supabase = window.VoiceBridgeAuth?.supabase;
    const user = window.VoiceBridgeAuth?.user;
    if (!supabase || !user) throw new Error(t('account.pleaseLogin'));

    const [subRes, usageRes, devicesRes] = await Promise.all([
      supabase.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle(),
      supabase.from("usage_events").select("status, audio_duration_ms").eq("user_id", user.id),
      supabase.from("devices").select("*").eq("user_id", user.id).order("last_seen_at", { ascending: false }),
    ]);

    if (subRes.error) throw new Error(t('account.getSubFailed'));
    if (usageRes.error) throw new Error(t('account.getUsageFailed'));
    if (devicesRes.error) throw new Error(t('account.getDevicesFailed'));

    const subscription = subRes.data || null;
    const usageEvents = usageRes.data || [];
    const devices = devicesRes.data || [];

    const plan = subscription && (subscription.plan === "admin")
      ? "admin"
      : (subscription && isPaidStatus(subscription.status) && subscription.plan === "pro")
        ? "pro"
        : "free";
    const usedSeconds = usageEvents
      .filter((event) => event.status === "success")
      .reduce((sum, event) => sum + Math.ceil((event.audio_duration_ms || 0) / 1000), 0);
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
    title.textContent = t('account.currentPlan');
    section.appendChild(title);

    const badge = document.createElement("span");
    if (data.plan === "admin") {
      badge.className = "plan-badge admin";
      badge.textContent = t('account.adminLabel');
    } else {
      badge.className = `plan-badge ${data.plan === "pro" ? "pro" : ""}`;
      badge.textContent = data.plan === "pro" ? t('account.planPro') : t('account.planFree');
    }
    section.appendChild(badge);

    const limits = PLAN_LIMITS[data.plan] || PLAN_LIMITS.free;

    const stats = document.createElement("div");
    stats.className = "usage-stats";
    if (data.plan === "admin") {
      stats.innerHTML = `
        <div class="usage-stat-row">
          <span class="usage-stat-label">${t('account.usedMonthlyQuota')}</span>
          <span class="usage-stat-value">${t('account.unlimitedSeconds', data.usedSeconds)}</span>
        </div>
      `;
    } else {
      const pct = Math.min(100, Math.round((data.usedSeconds / limits.monthlySeconds) * 100));
      stats.innerHTML = `
        <div class="usage-stat-row">
          <span class="usage-stat-label">${t('account.usedMonthlyQuota')}</span>
          <span class="usage-stat-value">${t('account.usedSecondsOfLimit', data.usedSeconds, limits.monthlySeconds, pct)}</span>
        </div>
      `;
    }
    section.appendChild(stats);

    if (data.plan !== "admin") {
      const pct = Math.min(100, Math.round((data.usedSeconds / limits.monthlySeconds) * 100));
      const track = document.createElement("div");
      track.className = "usage-bar-track";
      const fill = document.createElement("div");
      fill.className = `usage-bar-fill ${pct >= 90 ? "critical" : pct >= 70 ? "warning" : ""}`;
      fill.style.width = pct + "%";
      track.appendChild(fill);
      section.appendChild(track);
    }

    return section;
  }
  _renderPricing(data) {
    const section = document.createElement("div");
    section.className = "account-section";

    const title = document.createElement("p");
    title.className = "account-section-title";
    title.textContent = t('account.pricingTitle');
    section.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "pricing-grid";

    for (const [key, label] of [["free", t('account.planFree')], ["pro", t('account.planPro')]]) {
      const card = document.createElement("div");
      card.className = `pricing-card ${data.plan === key ? "active" : ""}`;

      const name = document.createElement("p");
      name.className = "pricing-card-name";
      name.textContent = label + (data.plan === key ? " ✓" : "");
      card.appendChild(name);

      const limits = PLAN_LIMITS[key];
      for (const [lKey, lLabel] of [["monthlySeconds", t('account.monthlyQuota')], ["maxAudioSeconds", t('account.maxPerAudio')], ["rateLimitPerMinute", t('account.rateLimitPerMin')]]) {
        const item = document.createElement("p");
        item.className = "pricing-card-item";
        item.textContent = `${lLabel}: ${t('account.secondsUnit', limits[lKey])}`;
        card.appendChild(item);
      }

      if (key === "pro" && data.plan !== "pro" && data.plan !== "admin") {
        const btn = document.createElement("button");
        btn.className = "pricing-card-btn";
        btn.type = "button";
        btn.textContent = t('account.upgradeToPro');
        btn.addEventListener("click", () => {
          void openBillingSession("billing-create-checkout-session", btn);
        });
        card.appendChild(btn);
      } else if (key === "pro" && (data.plan === "pro" || data.plan === "admin")) {
        const badge = document.createElement("span");
        badge.className = "pricing-card-badge";
        badge.textContent = t('account.currentPlanBadge');
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
    title.textContent = t('account.usageTitle');
    section.appendChild(title);

    const successRate = data.totalCount > 0 ? Math.round((data.successCount / data.totalCount) * 100) : 0;

    const rows = [
      [t('account.totalDuration'), t('account.secondsValue', data.usedSeconds)],
      [t('account.totalTranscriptions'), t('account.timesValue', data.successCount)],
      [t('account.successRate'), `${successRate}%`],
      [t('account.rejectedCount'), t('account.timesValue', data.rejectedCount)],
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
    title.textContent = t('account.subscriptionTitle');
    section.appendChild(title);

    const sub = data.subscription;
    if (!sub) {
      const hint = document.createElement("p");
      hint.style.cssText = "margin:0;font-size:13px;color:var(--text-muted)";
      hint.textContent = t('account.noSubscription');
      section.appendChild(hint);
      return section;
    }

    const statusMap = {
      active: t('account.statusActive'),
      trialing: t('account.statusTrialing'),
      past_due: t('account.statusPastDue'),
      canceled: t('account.statusCanceled'),
      unpaid: t('account.statusUnpaid'),
    };
    const rows = [
      [t('account.statusLabel'), statusMap[sub.status] || sub.status],
    ];

    if (sub.current_period_start && sub.current_period_end) {
      const fmt = (d) => new Date(d).toLocaleDateString(getIntlLocale(), { month: "numeric", day: "numeric" });
      rows.push([t('account.currentPeriod'), t('account.periodRange', fmt(sub.current_period_start), fmt(sub.current_period_end))]);
    }

    if (sub.cancel_at_period_end) {
      const warn = document.createElement("p");
      warn.style.cssText = "margin:6px 0 0;font-size:13px;color:#d97706";
      const expireDate = new Date(sub.current_period_end).toLocaleDateString(getIntlLocale());
      warn.textContent = t('account.willExpireOn', expireDate);
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
    portalBtn.textContent = t('account.manageSubscription');
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
    title.textContent = t('account.profileTitle');
    section.appendChild(title);

    // 邮箱行（脱敏）
    const email = data.user?.email || "";
    const masked = email.length > 2
      ? email.replace(/(.{2})(.*)(@.*)/, "$1***$3")
      : email;
    const emailRow = document.createElement("div");
    emailRow.className = "account-row";
    emailRow.innerHTML = `<span class="account-row-label">${t('account.emailLabel')}</span><span class="account-row-value">${masked}</span>`;
    section.appendChild(emailRow);

    const emailEditBtn = document.createElement("button");
    emailEditBtn.className = "account-action-btn";
    emailEditBtn.type = "button";
    emailEditBtn.textContent = t('account.editEmail');
    section.appendChild(emailEditBtn);

    const providers = Array.isArray(data.user?.app_metadata?.providers)
      ? data.user.app_metadata.providers
      : [];
    const usesGithubWithoutEmailPassword = providers.includes("github") && !providers.includes("email");

    // 密码行
    const pwdRow = document.createElement("div");
    pwdRow.className = "account-row";
    pwdRow.innerHTML = `<span class="account-row-label">${t('account.desktopPassword')}</span><span class="account-row-value">${usesGithubWithoutEmailPassword ? t('account.passwordUnset') : t('account.passwordSet')}</span>`;
    section.appendChild(pwdRow);

    const pwdEditBtn = document.createElement("button");
    pwdEditBtn.className = "account-action-btn";
    pwdEditBtn.type = "button";
    pwdEditBtn.textContent = usesGithubWithoutEmailPassword ? t('account.setPassword') : t('account.changePassword');
    section.appendChild(pwdEditBtn);

    // 邮箱编辑交互
    emailEditBtn.addEventListener("click", () => {
      emailEditBtn.classList.add("hidden");
      const group = document.createElement("div");
      group.className = "profile-edit-group";
      const input = document.createElement("input");
      input.className = "profile-edit-input";
      input.type = "email";
      input.placeholder = t('account.newEmailPlaceholder');
      const actions = document.createElement("div");
      actions.className = "profile-edit-actions";
      const cancel = document.createElement("button");
      cancel.className = "account-action-btn";
      cancel.type = "button";
      cancel.textContent = t('common.cancel');
      const confirm = document.createElement("button");
      confirm.className = "account-action-btn primary";
      confirm.type = "button";
      confirm.textContent = t('common.confirm');
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
          showToast(t('account.emailUpdateSent'));
          group.remove();
          emailEditBtn.classList.remove("hidden");
        } catch (err) {
          showToast(err.message || t('account.modifyFailed'), true);
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
      const newInput = document.createElement("input");
      newInput.className = "profile-edit-input";
      newInput.type = "password";
      newInput.placeholder = t('account.newPasswordPlaceholder');
      newInput.autocomplete = "new-password";
      const confirmInput = document.createElement("input");
      confirmInput.className = "profile-edit-input";
      confirmInput.type = "password";
      confirmInput.placeholder = t('account.confirmPasswordPlaceholder');
      confirmInput.autocomplete = "new-password";
      const actions = document.createElement("div");
      actions.className = "profile-edit-actions";
      const cancel = document.createElement("button");
      cancel.className = "account-action-btn";
      cancel.type = "button";
      cancel.textContent = t('common.cancel');
      const confirm = document.createElement("button");
      confirm.className = "account-action-btn primary";
      confirm.type = "button";
      confirm.textContent = t('common.confirm');
      cancel.addEventListener("click", () => {
        group.remove();
        pwdEditBtn.classList.remove("hidden");
      });
      confirm.addEventListener("click", async () => {
        const newPwd = newInput.value;
        if (!newPwd || newPwd.length < 6) {
          showToast(t('account.passwordTooShort'), true);
          return;
        }
        if (newPwd !== confirmInput.value) {
          showToast(t('account.passwordMismatch'), true);
          return;
        }
        confirm.disabled = true;
        try {
          const { error } = await window.VoiceBridgeAuth?.supabase.auth.updateUser({ password: newPwd });
          if (error) throw error;
          showToast(t('account.passwordSetSuccess'));
          pwdRow.querySelector(".account-row-value").textContent = t('account.passwordSet');
          pwdEditBtn.textContent = t('account.changePassword');
          group.remove();
          pwdEditBtn.classList.remove("hidden");
        } catch (err) {
          showToast(err.message || t('account.modifyFailed'), true);
        } finally {
          confirm.disabled = false;
        }
      });
      actions.appendChild(cancel);
      actions.appendChild(confirm);
      group.appendChild(newInput);
      group.appendChild(confirmInput);
      group.appendChild(actions);
      section.insertBefore(group, pwdEditBtn.nextSibling);
      currInput.focus();
    });

    // 退出登录按钮
    const logoutBtn = document.createElement("button");
    logoutBtn.className = "account-action-btn danger";
    logoutBtn.type = "button";
    logoutBtn.textContent = t('account.logout');
    logoutBtn.addEventListener("click", async () => {
      this.close();
      await window.VoiceBridgeAuth?.signOut();
    });
    section.appendChild(logoutBtn);

    // 删除账号按钮
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "account-action-btn danger";
    deleteBtn.type = "button";
    deleteBtn.textContent = t('account.deleteAccount');
    deleteBtn.style.marginTop = "4px";
    deleteBtn.style.borderColor = "#dc2626";
    deleteBtn.style.color = "#dc2626";
    deleteBtn.addEventListener("click", () => {
      this._openDeleteAccountDialog(deleteBtn);
    });
    section.appendChild(deleteBtn);

    return section;
  }

  /**
   * 删除账号对话框：输入"删除"二次确认 → 调用 account-delete Edge Function
   */
  _openDeleteAccountDialog(triggerBtn) {
    const confirmWord = getCurrentLocale() === 'zh-CN' ? '删除' : 'DELETE';

    // overlay
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;";

    const dialog = document.createElement("div");
    dialog.style.cssText = "background:var(--bg-card,#fff);border-radius:16px;max-width:400px;width:100%;padding:28px 24px;box-shadow:0 20px 60px rgba(0,0,0,.3);";

    const title = document.createElement("p");
    title.style.cssText = "font-size:18px;font-weight:800;margin:0 0 12px;color:#dc2626;";
    title.textContent = t('account.deleteAccount');
    dialog.appendChild(title);

    const hint = document.createElement("p");
    hint.style.cssText = "font-size:13px;color:var(--text-secondary,#666);margin:0 0 16px;line-height:1.6;";
    hint.textContent = t('account.deleteAccountHint');
    dialog.appendChild(hint);

    const confirmLabel = document.createElement("p");
    confirmLabel.style.cssText = "font-size:13px;color:var(--text,#1c1917);margin:0 0 6px;";
    confirmLabel.textContent = t('account.deleteAccountTypeConfirm');
    dialog.appendChild(confirmLabel);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = confirmWord;
    input.style.cssText = "width:100%;padding:10px 14px;border:1.5px solid var(--border,#ddd);border-radius:10px;font-size:15px;margin-bottom:16px;box-sizing:border-box;";
    dialog.appendChild(input);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:10px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = getCurrentLocale() === 'zh-CN' ? '取消' : 'Cancel';
    cancelBtn.style.cssText = "flex:1;padding:10px;border:1.5px solid var(--border,#ddd);border-radius:999px;background:transparent;font-size:14px;font-weight:600;cursor:pointer;";
    cancelBtn.addEventListener("click", () => overlay.remove());

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.textContent = t('account.deleteAccount');
    confirmBtn.style.cssText = "flex:1;padding:10px;border:none;border-radius:999px;background:#dc2626;color:#fff;font-size:14px;font-weight:700;cursor:pointer;";
    confirmBtn.disabled = true;
    confirmBtn.style.opacity = "0.4";

    input.addEventListener("input", () => {
      const matched = input.value.trim() === confirmWord;
      confirmBtn.disabled = !matched;
      confirmBtn.style.opacity = matched ? "1" : "0.4";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !confirmBtn.disabled) confirmBtn.click();
      if (e.key === "Escape") overlay.remove();
    });

    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = t('account.deleteAccountProgress');
      cancelBtn.disabled = true;

      const supabase = window.VoiceBridgeAuth?.supabase;
      if (!supabase) {
        overlay.remove();
        return;
      }
      try {
        const { data: session } = await supabase.auth.getSession();
        const resp = await fetch(
          `${window.__VB_CONFIG.supabaseUrl}/functions/v1/account-delete`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${session.session?.access_token || ""}`,
              "Content-Type": "application/json"
            }
          }
        );
        const body = await resp.json();
        if (!resp.ok || !body.ok) {
          const msg = body?.code === "admin_protected"
            ? t('account.deleteAccountAdminProtected')
            : body?.message || t('account.deleteAccountFailed');
          showToast(msg, true);
          overlay.remove();
          triggerBtn.disabled = false;
          return;
        }
        overlay.remove();
        this.close();
        showToast(t('account.deleteAccountSuccess'));
        // 登出并刷新
        await window.VoiceBridgeAuth?.signOut();
        setTimeout(() => location.reload(), 800);
      } catch (error) {
        showToast(error?.message || t('account.deleteAccountFailed'), true);
        overlay.remove();
        triggerBtn.disabled = false;
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    // 点击遮罩关闭
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
  }
  _renderDevices(data) {
    const section = document.createElement("div");
    section.className = "account-section";

    const title = document.createElement("p");
    title.className = "account-section-title";
    title.textContent = t('account.devicesTitle');
    section.appendChild(title);

    if (!data.devices.length) {
      const hint = document.createElement("p");
      hint.style.cssText = "margin:0;font-size:13px;color:var(--text-muted)";
      hint.textContent = t('account.noDevices');
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
      name.textContent = device.device_name || device.platform || t('account.unknownDevice');
      info.appendChild(name);
      const seen = document.createElement("p");
      seen.className = "device-last-seen";
      seen.textContent = lastSeen ? formatRelativeTime(now - lastSeen.getTime()) : t('account.unknown');
      info.appendChild(seen);
      item.appendChild(info);

      const removeBtn = document.createElement("button");
      removeBtn.className = "device-remove-btn";
      removeBtn.type = "button";
      removeBtn.textContent = t('common.remove');
      removeBtn.addEventListener("click", async () => {
        if (removeBtn.textContent === t('common.remove')) {
          removeBtn.textContent = t('common.confirmQuestion');
          setTimeout(() => { removeBtn.textContent = t('common.remove'); }, 3000);
          return;
        }
        removeBtn.disabled = true;
        try {
          const { error } = await window.VoiceBridgeAuth?.supabase
            .from("devices").delete().eq("id", device.id);
          if (error) throw error;
          item.remove();
          if (!section.querySelector(".device-item")) {
            section.innerHTML = `<p style='margin:0;font-size:13px;color:var(--text-muted)'>${t('account.noDevices')}</p>`;
          }
        } catch (err) {
          showToast(err.message || t('account.removeFailed'), true);
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
