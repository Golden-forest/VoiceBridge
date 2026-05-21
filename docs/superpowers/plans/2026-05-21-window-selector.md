# Window Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a window selector to the web UI so users can pick a target application window from their phone, and VoiceBridge will automatically switch to that window before pasting text.

**Architecture:** Server-side `windowManager.js` module uses AppleScript to enumerate visible windows and activate them. A new `GET /api/windows` endpoint exposes the list. The `outputText` function gains an optional `targetWindow` parameter that activates the window before pasting. Client-side adds a top-left dropdown button for window selection, persisted in localStorage.

**Tech Stack:** Node.js ESM, Express, osascript (macOS AppleScript), WebSocket, vanilla JS

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/server/input/windowManager.js` | Create | Enumerate and activate windows via AppleScript |
| `src/server/input/windowManager.test.js` | Create | Tests for windowManager |
| `src/server/input/outputText.js` | Modify | Add optional `targetWindow` parameter, activate window before paste |
| `src/server/input/outputText.test.js` | Modify | Add tests for targetWindow parameter |
| `src/server/ws.js` | Modify | Pass `targetWindow` from phrase messages to outputText |
| `src/server/routes/upload.js` | Modify | Accept targetWindow form fields, pass to outputText |
| `src/server/index.js` | Modify | Register `GET /api/windows` route |
| `src/public/index.html` | Modify | Add window selector button + dropdown HTML |
| `src/public/app.js` | Modify | Add WindowManager client logic, attach targetWindow to sends |
| `src/public/style.css` | Modify | Style the window selector dropdown + dark mode |

---

### Task 1: windowManager — listWindows

**Files:**
- Create: `src/server/input/windowManager.js`
- Create: `src/server/input/windowManager.test.js`

- [ ] **Step 1: Write the failing test for listWindows**

Create `src/server/input/windowManager.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

// Stub osascript before importing windowManager
let osascriptScript = "";
let osascriptResult = "";
let osascriptError = null;

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const originalExecFile = promisify(execFile);
const mockExecFile = async (cmd, args, opts) => {
  if (cmd === "osascript") {
    osascriptScript = args[args.length - 1];
    if (osascriptError) throw osascriptError;
    return { stdout: osascriptResult, stderr: "" };
  }
  return originalExecFile(cmd, args, opts);
};

// Monkey-patch the module to use our mock
import { listWindows } from "./windowManager.js";

test.beforeEach(() => {
  osascriptScript = "";
  osascriptResult = "";
  osascriptError = null;
});

test("listWindows returns empty array on non-macOS", async () => {
  // On non-darwin, should return empty
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    // Re-import is not needed if function checks process.platform internally
    const result = await listWindows({ execFileAsync: mockExecFile });
    assert.deepEqual(result, []);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("listWindows parses AppleScript output into grouped structure", async () => {
  osascriptResult = `{
    "Chrome": ["GitHub - Pull Requests", "ChatGPT"],
    "VS Code": ["VoiceBridge - app.js"],
    "微信": ["文件传输助手"]
  }`;

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 3);
  assert.equal(result[0].appName, "Chrome");
  assert.equal(result[0].windows.length, 2);
  assert.equal(result[0].windows[0].title, "GitHub - Pull Requests");
  assert.equal(result[1].appName, "VS Code");
  assert.equal(result[2].appName, "微信");
});

test("listWindows filters out VoiceBridge itself", async () => {
  osascriptResult = `{
    "VoiceBridge": ["Terminal"],
    "Chrome": ["GitHub"]
  }`;

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 1);
  assert.equal(result[0].appName, "Chrome");
});

test("listWindows filters out apps with no windows", async () => {
  osascriptResult = `{
    "Chrome": [],
    "VS Code": ["project"]
  }`;

  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.equal(result.length, 1);
  assert.equal(result[0].appName, "VS Code");
});

test("listWindows returns empty array on AppleScript error", async () => {
  osascriptError = new Error(" timed out.");
  const result = await listWindows({ execFileAsync: mockExecFile });
  assert.deepEqual(result, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/server/input/windowManager.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement listWindows**

Create `src/server/input/windowManager.js`:

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const APPLE_SCRIPT_LIST = `
tell application "System Events"
  set output to "{"
  set appList to name of every process whose visible is true
  set appCount to count of appList
  repeat with i from 1 to appCount
    set appName to item i of appList
    try
      tell process appName
        set winNames to name of every window
        if (count of winNames) > 0 then
          if output ≠ "{" then set output to output & ", "
          set output to output & "\"" & appName & "\": ["
          repeat with j from 1 to count of winNames
            if j > 1 then set output to output & ", "
            set output to output & "\"" & (item j of winNames) & "\""
          end repeat
          set output to output & "]"
        end if
      end tell
    end try
  end repeat
  set output to output & "}"
end tell
return output
`.trim();

export async function listWindows({ execFileAsync: execAsync = execFileAsync, platform = process.platform } = {}) {
  if (platform !== "darwin") {
    return [];
  }

  try {
    const { stdout } = await execAsync("osascript", ["-e", APPLE_SCRIPT_LIST], {
      timeout: 3000,
      windowsHide: true
    });

    const parsed = JSON.parse(stdout.trim());
    const SKIP_APPS = ["VoiceBridge", "Terminal", "node"];

    return Object.entries(parsed)
      .filter(([appName, windows]) => {
        if (!SKIP_APPS.some((skip) => appName.includes(skip))) return true;
        return false;
      })
      .filter(([, windows]) => windows && windows.length > 0)
      .map(([appName, windows]) => ({
        appName,
        windows: windows.map((title, index) => ({ title, index: index + 1 }))
      }));
  } catch {
    return [];
  }
}

export async function activateWindow(appName, windowTitle, { execFileAsync: execAsync = execFileAsync, platform = process.platform, logger = console } = {}) {
  if (platform !== "darwin") {
    return { success: false, error: "Only supported on macOS" };
  }

  try {
    // Escape double quotes and backslashes to prevent AppleScript injection
    const safeAppName = appName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const safeWindowTitle = windowTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const script = `
tell application "System Events"
  set frontmost of process "${safeAppName}" to true
end tell
delay 0.1
tell application "${safeAppName}"
  activate
  set index of window "${safeWindowTitle}" to 1
end tell
`.trim();

    await execAsync("osascript", ["-e", script], {
      timeout: 3000,
      windowsHide: true
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`activateWindow failed: ${message}`);
    return { success: false, error: message };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/server/input/windowManager.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/input/windowManager.js src/server/input/windowManager.test.js
git commit -m "feat(input): add windowManager for listing and activating macOS windows"
```

---

### Task 2: windowManager — activateWindow tests

**Files:**
- Modify: `src/server/input/windowManager.test.js`

- [ ] **Step 1: Add tests for activateWindow**

Append to `src/server/input/windowManager.test.js`:

```js
import { activateWindow } from "./windowManager.js";

test("activateWindow returns success false on non-macOS", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    const result = await activateWindow("Chrome", "GitHub", { execFileAsync: mockExecFile });
    assert.equal(result.success, false);
    assert.match(result.error, /macOS/);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("activateWindow calls osascript with correct app and window", async () => {
  osascriptResult = "";
  const result = await activateWindow("Chrome", "GitHub", { execFileAsync: mockExecFile });
  assert.equal(result.success, true);
  assert.ok(osascriptScript.includes("Chrome"));
  assert.ok(osascriptScript.includes("GitHub"));
});

test("activateWindow returns failure on error", async () => {
  osascriptError = new Error("window not found");
  const warns = [];
  const result = await activateWindow("NoApp", "NoWindow", {
    execFileAsync: mockExecFile,
    logger: { warn: (msg) => warns.push(msg) }
  });
  assert.equal(result.success, false);
  assert.ok(warns.length > 0);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test src/server/input/windowManager.test.js`
Expected: All 8 tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/input/windowManager.test.js
git commit -m "test(input): add activateWindow tests for windowManager"
```

---

### Task 3: Modify outputText to support targetWindow

**Files:**
- Modify: `src/server/input/outputText.js:1-56`
- Modify: `src/server/input/outputText.test.js:1-53`

- [ ] **Step 1: Write failing tests for targetWindow in outputText**

Append to `src/server/input/outputText.test.js`:

```js
test("outputText activates target window before pasting", async () => {
  const calls = [];

  const result = await outputText("hello", {
    autoPaste: true,
    pasteDelayMs: 0,
    targetWindow: { appName: "Chrome", windowTitle: "GitHub" },
    activateWindowFn: async () => calls.push(["activate"]),
    clipboardWriter: async (text) => calls.push(["clipboard", text]),
    pasteFn: async () => calls.push(["paste"])
  });

  assert.deepEqual(calls, [["activate"], ["clipboard", "hello"], ["paste"]]);
  assert.deepEqual(result, { copied: true, pasted: true, pasteError: null });
});

test("outputText skips activation when targetWindow is null", async () => {
  const calls = [];

  const result = await outputText("hello", {
    autoPaste: true,
    pasteDelayMs: 0,
    targetWindow: null,
    activateWindowFn: async () => calls.push(["activate"]),
    clipboardWriter: async (text) => calls.push(["clipboard", text]),
    pasteFn: async () => calls.push(["paste"])
  });

  assert.deepEqual(calls, [["clipboard", "hello"], ["paste"]]);
});

test("outputText falls back to paste when activation fails", async () => {
  const calls = [];
  const warns = [];

  const result = await outputText("hello", {
    autoPaste: true,
    pasteDelayMs: 0,
    targetWindow: { appName: "Chrome", windowTitle: "GitHub" },
    activateWindowFn: async () => calls.push(["activate-fail"]) || (() => { throw new Error("not found"); })(),
    clipboardWriter: async (text) => calls.push(["clipboard", text]),
    pasteFn: async () => calls.push(["paste"]),
    logger: { warn: (msg) => warns.push(msg) }
  });

  assert.ok(calls[0][0] === "clipboard");
  assert.equal(result.copied, true);
  assert.equal(result.pasted, true);
});

test("outputText ignores targetWindow when autoPaste is false", async () => {
  const calls = [];

  const result = await outputText("hello", {
    autoPaste: false,
    targetWindow: { appName: "Chrome", windowTitle: "GitHub" },
    activateWindowFn: async () => calls.push(["activate"]),
    clipboardWriter: async (text) => calls.push(["clipboard", text]),
    pasteFn: async () => calls.push(["paste"])
  });

  assert.deepEqual(calls, [["clipboard", "hello"]]);
  assert.equal(result.pasted, false);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test src/server/input/outputText.test.js`
Expected: New tests FAIL — targetWindow not handled

- [ ] **Step 3: Modify outputText.js to support targetWindow**

Replace the full content of `src/server/input/outputText.js` with:

```js
export async function outputText(
  text,
  {
    autoPaste,
    pasteDelayMs = 120,
    clipboardWriter = defaultClipboardWriter,
    pasteFn = defaultPasteFn,
    targetWindow = null,
    activateWindowFn = defaultActivateWindowFn,
    logger = console
  } = {}
) {
  await clipboardWriter(text);

  if (!autoPaste) {
    return {
      copied: true,
      pasted: false,
      pasteError: null
    };
  }

  if (targetWindow && targetWindow.appName) {
    try {
      const activateResult = await activateWindowFn(
        targetWindow.appName,
        targetWindow.windowTitle
      );
      if (!activateResult.success) {
        logger.warn?.(`Window activation failed: ${activateResult.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`Window activation error: ${message}`);
    }
    await delay(200);
  }

  await delay(pasteDelayMs);

  try {
    await pasteFn();
    return {
      copied: true,
      pasted: true,
      pasteError: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`Auto paste failed: ${message}`);
    return {
      copied: true,
      pasted: false,
      pasteError: message
    };
  }
}

function delay(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultClipboardWriter(text) {
  const { writeClipboard } = await import("./clipboard.js");
  await writeClipboard(text);
}

async function defaultPasteFn() {
  const { pasteClipboard } = await import("./paste.js");
  await pasteClipboard();
}

async function defaultActivateWindowFn(appName, windowTitle) {
  const { activateWindow } = await import("./windowManager.js");
  return activateWindow(appName, windowTitle);
}
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `node --test`
Expected: All tests PASS (existing 14 + new 4 = 18)

- [ ] **Step 5: Commit**

```bash
git add src/server/input/outputText.js src/server/input/outputText.test.js
git commit -m "feat(input): add targetWindow support to outputText for window-specific pasting"
```

---

### Task 4: Wire up server-side routes and WebSocket

**Files:**
- Modify: `src/server/index.js:1-86`
- Modify: `src/server/ws.js:1-60`
- Modify: `src/server/routes/upload.js:1-99`

- [ ] **Step 1: Add GET /api/windows route to index.js**

In `src/server/index.js`, add import at the top (after line 15):

```js
import { listWindows } from "./input/windowManager.js";
```

Add the route after the health endpoint (after line 45):

```js
app.get("/api/windows", async (_req, res) => {
  try {
    const windows = await listWindows();
    res.json({ ok: true, windows });
  } catch {
    res.json({ ok: true, windows: [] });
  }
});
```

- [ ] **Step 2: Modify ws.js to pass targetWindow to outputText**

In `src/server/ws.js`, change the phrase handler (lines 28-33) from:

```js
if (payload.type === "phrase" && typeof payload.text === "string") {
  const result = await outputText(payload.text, {
    autoPaste: Boolean(payload.autoPaste)
  });
  broadcast({ type: "output", ...result });
}
```

To:

```js
if (payload.type === "phrase" && typeof payload.text === "string") {
  const result = await outputText(payload.text, {
    autoPaste: Boolean(payload.autoPaste),
    targetWindow: payload.targetWindow || null
  });
  broadcast({ type: "output", ...result });
}
```

- [ ] **Step 3: Modify upload.js to accept and pass targetWindow**

In `src/server/routes/upload.js`, change line 37 from:

```js
const autoPaste = resolveAutoPaste(req.body.autoPaste, config.autoPaste);
```

To:

```js
const autoPaste = resolveAutoPaste(req.body.autoPaste, config.autoPaste);
const targetWindow = (req.body.targetAppName && req.body.targetWindowTitle)
  ? { appName: req.body.targetAppName, windowTitle: req.body.targetWindowTitle }
  : null;
```

And change line 52 from:

```js
const output = await outputText(text, { autoPaste });
```

To:

```js
const output = await outputText(text, { autoPaste, targetWindow });
```

- [ ] **Step 4: Run all tests**

Run: `node --test`
Expected: All 18 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/index.js src/server/ws.js src/server/routes/upload.js
git commit -m "feat(server): wire up window selector API endpoint and WebSocket/HTTP support"
```

---

### Task 5: Client-side HTML — window selector button and dropdown

**Files:**
- Modify: `src/public/index.html:12-16`

- [ ] **Step 1: Add window selector HTML**

In `src/public/index.html`, replace the `<header>` block (lines 12-16):

```html
<header>
  <p class="eyebrow">VoiceBridge</p>
  <h1>语音输入</h1>
  <p id="status" class="status">正在连接电脑端...</p>
</header>
```

With:

```html
<header>
  <div class="header-row">
    <p class="eyebrow">VoiceBridge</p>
    <div class="window-selector">
      <button id="windowBtn" class="window-btn" type="button">
        <span id="windowBtnLabel">光标位置</span>
        <span class="window-btn-arrow">▾</span>
      </button>
      <div id="windowDropdown" class="window-dropdown hidden">
        <div id="windowList" class="window-list">
          <p class="window-list-loading">加载中…</p>
        </div>
        <button id="windowRefreshBtn" class="window-refresh-btn" type="button">刷新</button>
      </div>
    </div>
  </div>
  <h1>语音输入</h1>
  <p id="status" class="status">正在连接电脑端...</p>
</header>
```

- [ ] **Step 2: Verify page loads in browser**

Run: `npm start`
Open: `https://localhost:3000`
Expected: See "光标位置 ▾" button in top-right of header area

- [ ] **Step 3: Commit**

```bash
git add src/public/index.html
git commit -m "feat(client): add window selector button and dropdown HTML structure"
```

---

### Task 6: Client-side CSS — window selector styling

**Files:**
- Modify: `src/public/style.css`

- [ ] **Step 1: Add window selector CSS**

In `src/public/style.css`, add these rules **before the dark mode media query** (before line 574):

```css
/* Header row layout */
.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Window selector */
.window-selector {
  position: relative;
}

.window-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s;
}

.window-btn:hover {
  border-color: #176b87;
}

.window-btn.active {
  border-color: #176b87;
  background: #f0f7fa;
  color: #176b87;
}

.window-btn-arrow {
  font-size: 11px;
  color: #9ca3af;
}

/* Dropdown */
.window-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  width: 260px;
  max-height: 320px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  z-index: 100;
}

.window-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.window-list-loading,
.window-list-empty {
  padding: 16px;
  color: #9ca3af;
  font-size: 13px;
  text-align: center;
}

.window-app-group {
  border-bottom: 1px solid #f3f4f6;
}

.window-app-group:last-child {
  border-bottom: 0;
}

.window-app-label {
  padding: 6px 12px 2px;
  font-size: 11px;
  font-weight: 700;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.window-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  border: 0;
  background: none;
  color: #374151;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
}

.window-item:hover {
  background: #f3f4f6;
}

.window-item.selected {
  background: #f0f7fa;
  color: #176b87;
  font-weight: 600;
}

.window-item-check {
  width: 14px;
  font-size: 12px;
  flex-shrink: 0;
}

.window-item-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.window-refresh-btn {
  display: block;
  width: 100%;
  padding: 8px;
  border: 0;
  border-top: 1px solid #f3f4f6;
  background: none;
  color: #6b7280;
  font-size: 12px;
  cursor: pointer;
}

.window-refresh-btn:hover {
  background: #f9fafb;
  color: #374151;
}
```

- [ ] **Step 2: Add dark mode styles**

Append inside the `@media (prefers-color-scheme: dark)` block (before the closing `}`):

```css
  .window-btn {
    background: #2b353a;
    border-color: #3b454a;
    color: #b5c0c7;
  }

  .window-btn:hover {
    border-color: #176b87;
  }

  .window-btn.active {
    background: #1a3035;
    color: #7fb3d0;
  }

  .window-dropdown {
    background: #1e282d;
    border-color: #2b353a;
  }

  .window-app-group {
    border-bottom-color: #2b353a;
  }

  .window-app-label {
    color: #6a8a9e;
  }

  .window-item {
    color: #f4f4f0;
  }

  .window-item:hover {
    background: #2b353a;
  }

  .window-item.selected {
    background: #1a3035;
    color: #7fb3d0;
  }

  .window-refresh-btn {
    border-top-color: #2b353a;
    color: #6a8a9e;
  }

  .window-refresh-btn:hover {
    background: #2b353a;
    color: #b5c0c7;
  }
```

- [ ] **Step 3: Verify styling in browser**

Run: `npm start`
Open: `https://localhost:3000`
Expected: Button visible in top-right with dropdown styling; dark mode works via system preference

- [ ] **Step 4: Commit**

```bash
git add src/public/style.css
git commit -m "feat(client): add window selector dropdown styling with dark mode"
```

---

### Task 7: Client-side JS — WindowSelector class

**Files:**
- Modify: `src/public/app.js:1-516`

- [ ] **Step 1: Add WindowSelector class and wire it up**

In `src/public/app.js`, add the following **before the `PhrasesManager` class** (before line 14):

```js
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
    this.el.btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggle();
    });
    this.el.refreshBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._fetchWindows();
    });
    document.addEventListener("click", (e) => {
      if (this._isOpen && !this.el.dropdown.contains(e.target)) {
        this._close();
      }
    });
    this._updateButton();
  }

  get targetWindow() {
    return this.selectedWindow;
  }

  _loadSelection() {
    try {
      return JSON.parse(localStorage.getItem(WindowSelector.STORAGE_KEY));
    } catch {
      return null;
    }
  }

  _saveSelection() {
    if (this.selectedWindow) {
      localStorage.setItem(WindowSelector.STORAGE_KEY, JSON.stringify(this.selectedWindow));
    } else {
      localStorage.removeItem(WindowSelector.STORAGE_KEY);
    }
  }

  _toggle() {
    if (this._isOpen) {
      this._close();
    } else {
      this._open();
    }
  }

  _open() {
    this._isOpen = true;
    this.el.dropdown.classList.remove("hidden");
    this._fetchWindows();
  }

  _close() {
    this._isOpen = false;
    this.el.dropdown.classList.add("hidden");
  }

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

        const isSelected = this.selectedWindow
          && this.selectedWindow.appName === group.appName
          && this.selectedWindow.windowTitle === win.title;

        if (isSelected) {
          btn.classList.add("selected");
        }

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
          if (isSelected) {
            this.selectedWindow = null;
          } else {
            this.selectedWindow = {
              appName: group.appName,
              windowTitle: win.title
            };
          }
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
```

Then, after `const phrases = new PhrasesManager();` (line 247), add:

```js
const windowSelector = new WindowSelector();
```

- [ ] **Step 2: Modify _sendPhrase in PhrasesManager to include targetWindow**

In `src/public/app.js`, change the `_sendPhrase` method (lines 112-123) from:

```js
_sendPhrase(text) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "phrase",
      text,
      autoPaste: autoPasteEl.checked
    }));
    setStatus("已发送常用语到电脑。");
  } else {
    setStatus("发送失败，请检查连接。", true);
  }
}
```

To:

```js
_sendPhrase(text) {
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
    setStatus("已发送常用语到电脑。");
  } else {
    setStatus("发送失败，请检查连接。", true);
  }
}
```

- [ ] **Step 3: Modify quick bar click handler to include targetWindow**

In `src/public/app.js`, change the quickPanel click handler (lines 259-274) — the `ws.send` block from:

```js
    ws.send(JSON.stringify({
      type: "phrase",
      text,
      autoPaste: autoPasteEl.checked
    }));
```

To:

```js
    const msg = {
      type: "phrase",
      text,
      autoPaste: autoPasteEl.checked
    };
    if (windowSelector.targetWindow) {
      msg.targetWindow = windowSelector.targetWindow;
    }
    ws.send(JSON.stringify(msg));
```

- [ ] **Step 4: Modify uploadAudio to include targetWindow**

In `src/public/app.js`, change the `uploadAudio` function (around lines 433-435) — after `formData.append("autoPaste", String(autoPasteEl.checked));`, add:

```js
    if (windowSelector.targetWindow) {
      formData.append("targetAppName", windowSelector.targetWindow.appName);
      formData.append("targetWindowTitle", windowSelector.targetWindow.windowTitle);
    }
```

- [ ] **Step 5: Verify full flow in browser**

Run: `npm start`
Open: `https://localhost:3000`
Test:
1. Click "光标位置 ▾" → dropdown opens, shows loading
2. Window list appears grouped by app
3. Click a window → dropdown closes, button shows app name
4. Click again → window list shows, selected item has ✓
5. Click same item → deselects, button back to "光标位置"
6. Send a quick command → text goes to selected window

- [ ] **Step 6: Commit**

```bash
git add src/public/app.js
git commit -m "feat(client): add WindowSelector class with dropdown, persistence, and send integration"
```

---

### Task 8: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `node --test`
Expected: All tests PASS

- [ ] **Step 2: Manual end-to-end test**

Run: `npm start`
Test the full flow:
1. Open phone browser → see window selector button
2. Click button → dropdown shows visible windows
3. Select a window → button shows app name
4. Send voice/quick command → text pastes into selected window
5. Deselect → text pastes at current cursor (original behavior)
6. Refresh page → selection persists from localStorage

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues from end-to-end testing"
```
