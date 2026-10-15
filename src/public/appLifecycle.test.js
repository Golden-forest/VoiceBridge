import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createPairingClient, buildNativeLanBaseUrl, lanTokenHeaders, lanTokenStorageKey, buildLanWsUrl } from "./lanMode.js";
import zhCN from "./i18n/zh-CN.js";
import en from "./i18n/en.js";
import { PLAN_LIMITS } from "../shared/planLimits.js";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
function fn(name) {
  const found = source.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(found, `missing function ${name}`);
  return found[0];
}
function element() {
  const classes = new Set();
  return {
    value: "", children: [], listeners: {}, disabled: false, style: {},
    classList: { add(...names) { names.forEach((n) => classes.add(n)); }, remove(...names) { names.forEach((n) => classes.delete(n)); }, contains(n) { return classes.has(n); }, toggle(n, on) { if (on) classes.add(n); else classes.delete(n); } },
    append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); }, replaceChildren(...nodes) { this.children = nodes; },
    insertBefore(node, before) { const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node); }, querySelector() { return element(); },
    addEventListener(name, callback) { this.listeners[name] = callback; }, setAttribute() {}, remove() { this.removed = true; }, focus() {},
  };
}
function harness(overrides = {}) {
  const elements = new Map(["#recoveredTranscriptPanel", "#recoveredTranscriptList"].map((name) => [name, element()]));
  const values = new Map();
  const storage = { getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  const status = [];
  const sent = [];
  const c = vm.createContext({
    console: { warn() {}, info() {}, error() {} }, performance, AbortController, DOMException, Blob, FormData, setTimeout, clearTimeout, clearInterval,
    document: { querySelector: (name) => elements.get(name), createElement: element, removeEventListener() {}, addEventListener() {}, visibilityState: "visible" },
    window: { VoiceBridgeAuth: { user: { id: "A" }, session: { user: { id: "A" } }, supabase: {} }, localStorage: storage, __VB_CONFIG: { voicebridgeMode: "cloud" } },
    identityUserId: "A", identityVersion: 1, cloudSetupVersion: 0, cloudSetupUserId: "", lanContextVersion: 0, targetVersion: 0, inputVersion: 0,
    selectedCloudDeviceId: "desktop-A", cloudDesktopDevices: [], activeCloudUserId: "", activeCloudPhoneDeviceId: "", cloudRealtime: null, cloudRealtimeSubscribed: false,
    nativeLanEndpoint: null, nativeLanRestoreAttempted: false, activeLanPairingOverlay: null, lanAffordanceTimer: null, lanProbe: null,
    currentUserPlan: "free", planBadge: null, isCloudMode: true, isNativeApp: true,
    recorder: null, isStarting: false, isRecording: false, isUploading: false, recordingWorkVersion: 0, recordingController: null, uploadController: null, recordingContext: null,
    maxRecordTimer: null, timerInterval: null, recordSeconds: 0, recordingStartedAt: 0, currentRecordingDurationMs: null,
    ws: null, wsRetryTimer: null, wsVisibilityHandler: null, wsRetryDelay: 1500,
    textInput: element(), autoPasteEl: { checked: true }, recordButton: element(), channelBadge: element(), cloudDeviceSelect: element(), recoveredTranscript: null,
    commandLibrary: { editingId: null, resetForIdentity() {}, async load() {} },
    windowSelector: { targetWindow: null, selectedWindow: null, _saveSelection() {}, _updateButton() {}, _close() {} },
    accountDrawer: { close() {}, el: { body: element() } },
    navigator: { mediaDevices: { getUserMedia() {} }, userAgent: "test" }, BrowserAudioContext: function () {},
    recordingTiming: { reset() {}, note() {} }, t: (key) => key,
    currentMaxAudioMs: () => 60000, beginRecordingState() { c.isRecording = true; },
    setActionButtonsDisabled() {}, setRecordIdle() {}, showToast() {}, updateTextInputState() {}, updateBillingControls() {},
    setConnectionStatus: (...args) => status.push(args), resetCloudDeviceSelect() {}, getPhoneDeviceId: (id) => `phone-${id}`,
    forgetNativeLanEndpoint() {}, rememberNativeLanEndpoint() {}, rememberCloudDesktopId() {}, syncCloudConnectionStatus() {}, updateCloudLanEndpoints() {},
    createPairingClient, buildNativeLanBaseUrl, lanTokenHeaders, lanTokenStorageKey, buildLanWsUrl,
    copyToPhoneClipboard() {}, selectedCloudDeviceIsCompatible: () => true, performNativeFeedback() {},
    lastAutoPastedText: "", lastAutoPasteTimer: null,
    sendTextToDesktop: async (text, options) => { sent.push({ text, ...options }); return true; },
    ...overrides
  });
  vm.runInContext(fn("isCurrentIdentity"), c);
  c.__elements = elements;
  c.__status = status;
  c.__sent = sent;
  return c;
}
function load(c, names) { vm.runInContext(names.map(fn).join("\n"), c); }
const contextFunctions = ["setTextInputValue", "captureRecordingContext", "isCurrentRecordingIdentity", "isCurrentRecordingTarget", "retainRecognizedText", "acceptRecognizedText"];
const lanFunctions = ["currentLanBinding", "isCurrentLanBinding", "isNativeLanActive", "disconnectNativeLan", "selectCloudDesktop"];
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("rapid clicks start only one recorder and identity cancellation closes late permission results", async () => {
  let resolveStart;
  let started = 0;
  let cancelled = 0;
  const c = harness({ recordWavUntilStopped: () => { started++; return new Promise((resolve) => { resolveStart = resolve; }); } });
  load(c, [...contextFunctions, ...lanFunctions, "startRecording", "toggleRecording", "cancelRecordingWork", "finishUpload"]);
  const first = c.toggleRecording();
  await c.toggleRecording();
  assert.equal(started, 1);
  assert.equal(c.isStarting, true);
  c.cancelRecordingWork();
  resolveStart({ async cancel() { cancelled++; } });
  await first;
  assert.equal(cancelled, 1);
  assert.equal(c.recorder, null);
  assert.equal(c.isRecording, false);
});

test("changed desktop or new draft keeps transcription recoverable without sending or overwriting", async () => {
  for (const change of ["desktop", "draft"]) {
    const c = harness();
    load(c, [...contextFunctions, ...lanFunctions]);
    const context = c.captureRecordingContext();
    if (change === "desktop") c.selectCloudDesktop("desktop-B");
    c.textInput.value = "new draft";
    c.inputVersion++;
    c.acceptRecognizedText("spoken for A", context);
    await tick();
    assert.equal(c.__sent.length, 0);
    assert.equal(c.textInput.value, "new draft");
    const row = c.__elements.get("#recoveredTranscriptList").children[0];
    assert.equal(row.children[0].value, "spoken for A");
    row.children[1].listeners.click();
    assert.equal(c.textInput.value, "new draft\nspoken for A");
  }
});

test("late transcription from a previous identity is neither rendered nor sent", async () => {
  const c = harness();
  load(c, [...contextFunctions, ...lanFunctions]);
  const context = c.captureRecordingContext();
  c.identityVersion++;
  c.identityUserId = "B";
  c.window.VoiceBridgeAuth.user = { id: "B" };
  c.acceptRecognizedText("A private text", context);
  assert.equal(c.textInput.value, "");
  assert.equal(c.recoveredTranscript, null);
  assert.equal(c.__sent.length, 0);
});

test("unchanged context sends the captured target and keeps failures recoverable", async () => {
  const c = harness({ sendTextToDesktop: async () => false });
  load(c, [...contextFunctions, ...lanFunctions]);
  const context = c.captureRecordingContext();
  c.acceptRecognizedText("transcript", context);
  await tick();
  assert.equal(c.textInput.value, "transcript");
  assert.equal(c.__elements.get("#recoveredTranscriptList").children[0].children[0].value, "transcript");
});

test("late LAN activation cannot connect after the selected desktop changes", async () => {
  let resolveStatus;
  let connected = 0;
  const c = harness({ createPairingClient: () => ({ status: () => new Promise((resolve) => { resolveStatus = resolve; }) }), connectWebSocket: () => connected++ });
  load(c, [...lanFunctions, "activateNativeLan", "finishNativeLanActivation"]);
  const pending = c.activateNativeLan({ host: "192.168.1.10", port: 3000, httpPort: 3001 });
  c.selectCloudDesktop("desktop-B");
  resolveStatus({ paired: true });
  await pending;
  assert.equal(c.nativeLanEndpoint, null);
  assert.equal(connected, 0);
});

test("device switches invalidate the old LAN socket and ignore its late callbacks", () => {
  const sockets = [];
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.listeners = {}; this.readyState = 0; sockets.push(this); }
    addEventListener(event, handler) { this.listeners[event] = handler; }
    close(code) { this.closed = true; this.listeners.close?.({ code }); }
  }
  const c = harness({ WebSocket: Socket });
  load(c, [...lanFunctions, "connectWebSocket"]);
  c.nativeLanEndpoint = { host: "192.168.1.10", port: 3000, httpPort: 3001, ...c.currentLanBinding() };
  c.connectWebSocket();
  const old = sockets[0];
  c.selectCloudDesktop("desktop-B");
  old.listeners.open();
  old.listeners.message({ data: JSON.stringify({ type: "result", text: "old desktop" }) });
  old.listeners.close({ code: 1006 });
  assert.equal(c.ws, null);
  assert.equal(c.nativeLanEndpoint, null);
  assert.equal(c.textInput.value, "");
  assert.equal(c.__status.length, 0);
  assert.equal(c.wsRetryTimer, null);
});

function deviceClient(lookup = async () => ({ data: null, error: null })) {
  return { from() { return {
    select() { return this; }, eq() { return this; }, maybeSingle: lookup,
    async insert() { return { error: null }; }, update() { return this; }, then(resolve, reject) { return Promise.resolve({ error: null }).then(resolve, reject); }
  }; } };
}

test("device registration errors do not subscribe to cloud channels", async () => {
  let subscriptions = 0;
  const c = harness({ CloudRealtime: class { constructor() { subscriptions++; } } });
  c.window.VoiceBridgeAuth.supabase = deviceClient(async () => ({ error: { message: "registration failed" } }));
  load(c, ["handleAuthState", "stopCloudRealtime"]);
  await c.handleAuthState({ detail: { session: { user: { id: "A" } }, user: { id: "A" } } });
  assert.equal(subscriptions, 0);
  assert.equal(c.cloudRealtime, null);
  assert.equal(c.cloudSetupUserId, "");
  assert.equal(c.__status[0][0], "error");
});

test("old account registration cannot replace the new account realtime", async () => {
  let resolveOldLookup;
  let lookupCount = 0;
  const users = [];
  const c = harness({ cancelRecordingWork() {}, CloudRealtime: class { constructor(options) { users.push(options.user.id); } async start() {} async stop() {} } });
  c.window.VoiceBridgeAuth.supabase = deviceClient(() => ++lookupCount === 1 ? new Promise((resolve) => { resolveOldLookup = resolve; }) : Promise.resolve({ data: null, error: null }));
  load(c, [...lanFunctions, "handleAuthState", "stopCloudRealtime", "setTextInputValue"]);
  const old = c.handleAuthState({ detail: { session: {}, user: { id: "A" } } });
  await tick();
  c.window.VoiceBridgeAuth.user = { id: "B" };
  await c.handleAuthState({ detail: { session: {}, user: { id: "B" } } });
  resolveOldLookup({ data: null, error: null });
  await old;
  assert.deepEqual(users, ["B"]);
  assert.equal(c.activeCloudUserId, "B");
});

test("private command load and writes from an earlier identity cannot repopulate the library", async () => {
  let resolveOld;
  const c = harness({ activeCommandStore: { list: () => new Promise((resolve) => { resolveOld = resolve; }) } });
  const classSource = source.slice(source.indexOf("class CommandLibrary {"), source.indexOf("// === Initialize ==="));
  vm.runInContext(classSource, c);
  const Library = vm.runInContext("CommandLibrary", c);
  const library = Object.create(Library.prototype);
  Object.assign(library, { _loadVersion: 0, editingId: null, commands: [], activeCategory: "General", container: element(), closeAddDialog() {}, renderTabs() {}, render() {} });
  const pending = library.load();
  c.identityVersion++;
  c.identityUserId = "B";
  c.window.VoiceBridgeAuth.user = { id: "B" };
  library.resetForIdentity();
  resolveOld([{ id: "A-private", text: "A secret" }]);
  await pending;
  assert.equal(library.commands.length, 0);
  c.activeCommandStore.list = async () => [{ id: "B-private", text: "B phrase", category: "General" }];
  library._migrateLocalStoragePhrases = async () => {};
  await library.load();
  assert.equal(library.commands[0].id, "B-private");
});

test("monthly account usage matches server settlement statuses and sums milliseconds before rounding", async () => {
  const filters = [];
  const c = harness();
  const usage = [
    { status: "success", audio_duration_ms: 100 },
    { status: "success", audio_duration_ms: 100 },
    { status: "processing", audio_duration_ms: 300 },
    { status: "unknown", audio_duration_ms: 500 },
    { status: "failed", audio_duration_ms: 5000 },
  ];
  c.window.VoiceBridgeAuth.supabase = { from(table) { const result = { data: table === "usage_events" ? usage : table === "devices" ? [] : null, error: null }; return {
    select() { return this; }, eq() { return this; }, order() { return this; }, range() { return this; }, gte(key, value) { filters.push([key, value]); return this; }, maybeSingle() { return Promise.resolve(result); }, then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); }
  }; } };
  c.isPaidStatus = () => false;
  const classSource = source.slice(source.indexOf("class AccountDrawer {"), source.indexOf("const accountDrawer = new AccountDrawer();"));
  vm.runInContext(classSource, c);
  const Drawer = vm.runInContext("AccountDrawer", c);
  const data = await Drawer.prototype._fetchData.call(Object.create(Drawer.prototype));
  assert.equal(data.usedSeconds, 1);
  assert.equal(data.successCount, 2);
  assert.equal(filters[0][0], "created_at");
  assert.match(filters[0][1], /-01T00:00:00\.000Z$/);
});

test("a late manual send acknowledgement preserves edited drafts and another account's input", async () => {
  for (const change of ["draft", "identity", "auth-event-pending", "unchanged"]) {
    let resolveSend;
    const c = harness({ sendTextToDesktop: () => new Promise((resolve) => { resolveSend = resolve; }) });
    load(c, ["sendTextInput", "setTextInputValue"]);
    c.setTextInputValue("sent text");
    const pending = c.sendTextInput();
    if (change === "draft") c.setTextInputValue("new draft");
    if (change === "identity") {
      c.identityVersion++;
      c.identityUserId = "B";
      c.window.VoiceBridgeAuth.user = { id: "B" };
      c.setTextInputValue("B draft");
    }
    if (change === "auth-event-pending") c.window.VoiceBridgeAuth.user = { id: "B" };
    resolveSend(true);
    await pending;
    assert.equal(c.textInput.value, change === "draft" ? "new draft" : change === "identity" ? "B draft" : change === "unchanged" ? "" : "sent text");
  }
});

function libraryPrototype(c) {
  vm.runInContext(source.slice(source.indexOf("class CommandLibrary {"), source.indexOf("// === Initialize ===")), c);
  return vm.runInContext("CommandLibrary.prototype", c);
}

test("private command responses are ignored as soon as auth changes, before its deferred handler", async () => {
  let resolveList;
  const c = harness({ activeCommandStore: { list: () => new Promise((resolve) => { resolveList = resolve; }) } });
  const library = Object.create(libraryPrototype(c));
  Object.assign(library, { _loadVersion: 0, commands: [], activeCategory: "General", renderTabs() {}, render() {}, _migrateLocalStoragePhrases() {} });
  const pending = library.load();
  c.window.VoiceBridgeAuth.user = { id: "B" };
  resolveList([{ id: "A-private", text: "A secret" }]);
  await pending;
  assert.equal(library.commands.length, 0);
});

test("late deletion of one command does not exit a different command's editing session", async () => {
  let resolveDelete;
  let exits = 0;
  const c = harness({ activeCommandStore: { remove: () => new Promise((resolve) => { resolveDelete = resolve; }) } });
  const library = Object.create(libraryPrototype(c));
  Object.assign(library, { commands: [{ id: "one" }, { id: "two" }], editingId: "one", _exitEditMode() { exits++; } });
  const pending = library._deleteCommand("one");
  library.editingId = "two";
  resolveDelete();
  await pending;
  assert.equal(exits, 0);
  assert.equal(library.commands.length, 1);
});

test("a previous identity's add completion cannot close the new account's dialog", async () => {
  let resolveAdd;
  let closes = 0;
  const c = harness();
  c.document.getElementById = (id) => ({ value: id === "addCommandInput" ? "A phrase" : "General" });
  const library = Object.create(libraryPrototype(c));
  Object.assign(library, { addCommand: () => new Promise((resolve) => { resolveAdd = resolve; }), closeAddDialog() { closes++; } });
  const pending = library.confirmAdd();
  c.identityVersion++;
  c.identityUserId = "B";
  c.window.VoiceBridgeAuth.user = { id: "B" };
  resolveAdd();
  await pending;
  assert.equal(closes, 0);
});

function drawerPrototype(c) {
  vm.runInContext(source.slice(source.indexOf("class AccountDrawer {"), source.indexOf("const accountDrawer = new AccountDrawer();")), c);
  return vm.runInContext("AccountDrawer.prototype", c);
}

test("monthly usage fetches the second page with stable ordering and rejects incomplete or stale results", async () => {
  for (const outcome of ["success", "error", "identity"]) {
    const ranges = [];
    const orders = [];
    const c = harness();
    c.window.VoiceBridgeAuth.supabase = { from() { return {
      select() { return this; }, eq() { return this; }, gte() { return this; },
      order(column, options) { orders.push([column, options.ascending]); return this; },
      async range(start, end) {
        ranges.push([start, end]);
        if (!start) return { data: Array.from({ length: 1000 }, () => ({ status: "success", audio_duration_ms: 100 })), error: null };
        if (outcome === "error") return { data: null, error: { message: "second page unavailable" } };
        if (outcome === "identity") c.window.VoiceBridgeAuth.user = { id: "B" };
        return { data: [{ status: "unknown", audio_duration_ms: 500 }], error: null };
      }
    }; } };
    const drawer = Object.create(drawerPrototype(c));
    const result = drawer._fetchMonthlyUsage("A", "2026-10-01T00:00:00.000Z", c.identityVersion);
    if (outcome === "success") {
      const events = await result;
      assert.equal(events.length, 1001);
      assert.equal(events[1000].audio_duration_ms, 500);
    } else await assert.rejects(result, outcome === "identity" ? { name: "AbortError" } : /account.getUsageFailed/);
    assert.deepEqual(ranges, [[0, 999], [1000, 1999]]);
    assert.deepEqual(orders, [["created_at", true], ["id", true], ["created_at", true], ["id", true]]);
  }
});

test("account deletion stays bound to the identity that opened its confirmation dialog", async () => {
  for (const changeAt of ["confirmation", "session"]) {
    let resolveSession;
    let requests = 0;
    const c = harness({ getCurrentLocale: () => "zh-CN", fetch: async () => { requests++; return { ok: true, async json() { return { ok: true }; } }; } });
    c.document.body = element();
    c.window.VoiceBridgeAuth.supabase.auth = { getSession: () => new Promise((resolve) => { resolveSession = resolve; }) };
    const drawer = Object.create(drawerPrototype(c));
    drawer._openDeleteAccountDialog(element());
    const overlay = c.document.body.children[0];
    const confirm = overlay.children[0].children[4].children[1];
    if (changeAt === "confirmation") c.window.VoiceBridgeAuth.user = { id: "B" };
    const pending = confirm.listeners.click();
    if (changeAt === "session") {
      c.window.VoiceBridgeAuth.user = { id: "B" };
      resolveSession({ data: { session: { user: { id: "B" }, access_token: "B-token" } } });
    }
    await pending;
    assert.equal(requests, 0);
    assert.equal(overlay.removed, true);
  }
});

test("closing the account drawer clears an outstanding deletion confirmation", () => {
  const c = harness({ getCurrentLocale: () => "zh-CN" });
  c.document.body = element();
  const drawer = Object.create(drawerPrototype(c));
  drawer.el = { drawer: element() };
  drawer._openDeleteAccountDialog(element());
  const overlay = c.document.body.children[0];
  drawer.close();
  assert.equal(overlay.removed, true);
  assert.equal(drawer._deleteOverlay, null);
});

test("account deletion messages are translated and rate limits use requests per minute", () => {
  for (const messages of [zhCN, en]) {
    for (const key of ["deleteAccount", "deleteAccountHint", "deleteAccountTypeConfirm", "deleteAccountProgress", "deleteAccountAdminProtected", "deleteAccountFailed", "deleteAccountSuccess"]) {
      assert.equal(typeof messages.account[key], "string", key);
      assert.ok(messages.account[key].length > 0, key);
    }
    for (const key of ["desktopPassword", "setPassword", "passwordSetSuccess"]) assert.doesNotMatch(messages.account[key], /桌面|desktop/i);
    const c = harness({ PLAN_LIMITS, t: (key, ...args) => {
      const value = key.split(".").reduce((value, part) => value?.[part], messages);
      return typeof value === "function" ? value(...args) : value;
    } });
    const drawer = Object.create(drawerPrototype(c));
    const pricing = drawer._renderPricing({ plan: "pro" });
    const rateRows = pricing.children[1].children.map((card) => card.children[3].textContent);
    assert.match(rateRows[0], messages === zhCN ? /10 次\/分$/ : /10 req\/min$/);
    assert.match(rateRows[1], messages === zhCN ? /30 次\/分$/ : /30 req\/min$/);
  }
});

test("email and password forms cannot update a different identity or display a stale completion", { timeout: 1000 }, async () => {
  for (const form of ["email", "password"]) for (const changeAt of ["confirm", "session", "completion", "none"]) {
    let resolveSession;
    let resolveUpdate;
    let updates = 0;
    let submitted;
    let toasts = 0;
    const c = harness({ showToast: () => toasts++ });
    c.window.VoiceBridgeAuth.supabase.auth = {
      getSession: () => new Promise((resolve) => { resolveSession = resolve; }),
      updateUser: (payload) => { submitted = payload; updates++; return new Promise((resolve) => { resolveUpdate = resolve; }); }
    };
    const drawer = Object.create(drawerPrototype(c));
    const profile = drawer._renderProfile({ user: { id: "A", email: "a@example.invalid", app_metadata: { providers: ["github"] } } });
    profile.children[form === "email" ? 2 : 4].listeners.click();
    const group = profile.children.find((node) => node.className === "profile-edit-group");
    group.children[0].value = form === "email" ? "new@example.invalid" : "secret123";
    if (form === "password") group.children[1].value = "secret123";
    const confirm = group.children[form === "email" ? 1 : 2].children[1];
    if (changeAt === "confirm") c.window.VoiceBridgeAuth.user = { id: "B" };
    const pending = confirm.listeners.click();
    if (changeAt === "session") {
      c.window.VoiceBridgeAuth.user = { id: "B" };
      resolveSession({ data: { session: { user: { id: "B" } } }, error: null });
    } else if (changeAt === "completion" || changeAt === "none") {
      resolveSession({ data: { session: { user: { id: "A" } } }, error: null });
      await tick();
      if (changeAt === "completion") c.window.VoiceBridgeAuth.user = { id: "B" };
      resolveUpdate({ error: null });
    }
    await pending;
    const allowed = changeAt === "completion" || changeAt === "none";
    assert.equal(updates, allowed ? 1 : 0, `${form} ${changeAt}`);
    assert.equal(toasts, changeAt === "none" ? 1 : 0, `${form} ${changeAt}`);
    if (allowed) assert.deepEqual(JSON.parse(JSON.stringify(submitted)), form === "email" ? { email: "new@example.invalid" } : { password: "secret123" });
  }
});

test("a transient presence flap does not tear down a healthy native LAN connection", () => {
  const disconnected = [];
  let lanActive = true;
  let endpointPresent = false;
  const c = harness({
    isNativeLanActive: () => lanActive,
    disconnectNativeLan: () => { lanActive = false; disconnected.push(1); },
    nativeLanEndpoint: { host: "192.168.1.10", port: 3000, httpPort: 3001 },
    findMatchingLanEndpoint: (stored, endpoints) => endpointPresent,
    LanProbe: class { bindWindow() {} setEndpoints() {} },
    maybeRestoreNativeLan: async () => {},
    scheduleLanAffordanceRefresh: () => {},
    nativeLanEndpointMissCount: 0
  });
  load(c, ["updateCloudLanEndpoints"]);
  const flap = () => c.updateCloudLanEndpoints([]);
  flap();
  assert.equal(disconnected.length, 0, "two consecutive missing-presence updates keep the LAN link");
  flap();
  assert.equal(disconnected.length, 0, "a single flap must not kill the healthy direct link");
  flap();
  assert.equal(disconnected.length, 1, "sustained absence disconnects");
  // 端点回到 presence 列表 → 缺失计数复位，随后的短抖动不再累积误杀
  lanActive = true;
  endpointPresent = true;
  c.updateCloudLanEndpoints([{ deviceId: "desktop-A", lanEndpoints: [{ host: "192.168.1.10", port: 3000 }] }]);
  endpointPresent = false;
  flap();
  flap();
  assert.equal(disconnected.length, 1, "a matching presence update resets the miss counter");
  flap();
  assert.equal(disconnected.length, 2, "the counter restarts after a reset");
});

test("an error frame from the desktop surfaces haptic and toast feedback", () => {
  const sockets = [];
  const feedback = [];
  const toasts = [];
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.listeners = {}; this.readyState = 1; sockets.push(this); }
    addEventListener(event, handler) { this.listeners[event] = handler; }
    close(code) { this.closed = true; this.listeners.close?.({ code }); }
  }
  const c = harness({
    WebSocket: Socket,
    performNativeFeedback: (kind) => feedback.push(kind),
    showToast: (message, isError) => toasts.push([message, isError])
  });
  load(c, [...lanFunctions, "connectWebSocket"]);
  c.nativeLanEndpoint = { host: "192.168.1.10", port: 3000, httpPort: 3001, ...c.currentLanBinding() };
  c.connectWebSocket();
  sockets[0].listeners.open();
  sockets[0].listeners.message({ data: JSON.stringify({ type: "error", message: "电脑输入通道已关闭。" }) });
  assert.deepEqual(feedback, ["error"], "error frames trigger error haptics");
  assert.deepEqual(toasts, [["电脑输入通道已关闭。", true]], "error frames surface the message as an error toast");
});
