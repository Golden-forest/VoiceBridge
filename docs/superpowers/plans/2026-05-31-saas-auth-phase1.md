# Phase 1: Supabase Auth & Database Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user authentication (email + password) via Supabase Auth so users can register, log in, and see their authenticated state with an empty device list — validating the entire auth chain.

**Architecture:** The local Express server continues serving static files and WebSocket as before. Supabase provides cloud-hosted Auth (session management via JWT + localStorage), PostgreSQL database (devices, commands, transcriptions tables with RLS), and a JS client loaded via CDN import map. An auth overlay gates the main UI; authenticated state persists across page reloads.

**Tech Stack:** Supabase (Auth, PostgreSQL, RLS), `@supabase/supabase-js` v2 (CDN via import map), existing Express server, vanilla JS (no bundler).

**Design spec:** `docs/superpowers/specs/2026-05-31-saas-auth-design.md`

**Prerequisite (manual, done before coding):**
1. Create a Supabase project at [supabase.com/dashboard](https://supabase.com/dashboard)
2. In Supabase Dashboard → Authentication → Providers → Email → enable "Confirm email" (keep enabled for now)
3. Copy project URL and anon (public) key
4. Add to `.env`:
   ```
   SUPABASE_URL=https://<your-project-id>.supabase.co
   SUPABASE_ANON_KEY=eyJ...
   ```

---

## File Structure

```
Modified files:
  src/server/index.js:44-45       — Add /config.js endpoint (inject Supabase credentials)
  src/public/index.html:13        — Add import map for @supabase/supabase-js
  src/public/index.html:25-31     — Add user menu button to header
  src/public/index.html:155-159   — Add auth overlay HTML + config.js script tag
  src/public/style.css:1451        — Append auth overlay + user menu styles
  src/public/app.js:763-765        — Gate initialization behind auth event
  src/public/app.js:1094           — Gate WebSocket behind auth event
  .env.example:9                  — Add SUPABASE_URL, SUPABASE_ANON_KEY
  package.json                    — Add @supabase/supabase-js dependency

New files:
  src/public/auth.js               — Supabase client init, auth UI logic, session management, device list query
```

---

### Task 1: Install Dependency & Configure Environment

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Install @supabase/supabase-js**

Run: `npm install @supabase/supabase-js`

Expected: Package added to dependencies in package.json.

- [ ] **Step 2: Add Supabase env vars to .env.example**

Append to `.env.example`:

```
# Supabase (cloud backend)
SUPABASE_URL=
SUPABASE_ANON_KEY=
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: add @supabase/supabase-js dependency and env vars"
```

---

### Task 2: Server — Add /config.js Endpoint

The frontend needs Supabase credentials at runtime. Instead of hardcoding, the server injects them via a dynamic JS endpoint. The anon key is designed to be public (restricted by RLS).

**Files:**
- Modify: `src/server/index.js:45`

- [ ] **Step 1: Add /config.js route**

After `app.use(express.static(publicDir));` (line 45), before the `/api/health` route, add:

```javascript
app.get("/config.js", (_req, res) => {
  res.type("application/javascript");
  const config = {
    SUPABASE_URL: process.env.SUPABASE_URL || "",
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || ""
  };
  res.send(`window.__VB_CONFIG = ${JSON.stringify(config)};`);
});
```

- [ ] **Step 2: Verify server starts and /config.js returns valid JS**

Run: `node src/server/index.js`

In another terminal:
```bash
curl -sk https://localhost:3000/config.js
```

Expected output (with empty env vars):
```javascript
window.__VB_CONFIG = {"SUPABASE_URL":"","SUPABASE_ANON_KEY":""};
```

With env vars set in `.env`, it returns the actual values. The anon key is safe to expose — Supabase RLS restricts data access regardless.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.js
git commit -m "feat(server): add /config.js endpoint for Supabase credentials injection"
```

---

### Task 3: Database Schema — Create Tables with RLS

Apply SQL migration via Supabase MCP tool. This creates the three tables defined in the design spec, all with Row Level Security ensuring users can only access their own data.

**Files:**
- Supabase cloud (applied via MCP, no local file needed for Phase 1)

- [ ] **Step 1: Apply migration — create tables and RLS**

Use Supabase MCP `apply_migration` tool with:

Name: `create_core_tables`

Query:
```sql
-- Devices: one user can bind multiple Desktop Agents
create table devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  platform    text not null default 'macos',
  last_seen   timestamptz,
  created_at  timestamptz default now()
);

-- Commands: replaces commands.json file
create table commands (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text not null,
  text        text not null,
  category    text not null default 'uncategorized',
  sort_order  int not null default 0,
  is_favorite boolean not null default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Transcriptions: usage tracking
create table transcriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  device_id   uuid references devices(id),
  text        text not null,
  audio_size  int,
  duration_ms int,
  created_at  timestamptz default now()
);

-- RLS: enable row level security on all tables
alter table devices enable row level security;
alter table commands enable row level security;
alter table transcriptions enable row level security;

-- RLS policies: users can only manage their own data
create policy "users manage own devices"
  on devices for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users manage own commands"
  on commands for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users manage own transcriptions"
  on transcriptions for all using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

- [ ] **Step 2: Verify tables exist**

Use Supabase MCP `list_tables` tool with schemas `["public"]` and verbose `true`.

Expected: Three tables visible: `devices`, `commands`, `transcriptions`, each with columns matching the schema, primary keys, and foreign key constraints to `auth.users(id)`.

- [ ] **Step 3: Verify RLS policies are active**

Use Supabase MCP `get_advisors` tool with type `"security"`.

Expected: No warnings about missing RLS policies for the three tables.

---

### Task 4: HTML — Import Map, Auth Overlay, User Menu

Three HTML changes: (1) import map for Supabase JS CDN, (2) auth overlay markup, (3) user menu button in header.

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: Add import map before `<script src="/app.js">`**

Replace line 159:
```html
    <script src="/app.js" type="module"></script>
```

With:
```html
    <script type="importmap">
    {
      "imports": {
        "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2"
      }
    }
    </script>
    <script src="/config.js"></script>
    <script src="/auth.js" type="module"></script>
    <script src="/app.js" type="module"></script>
```

Note: `auth.js` loads before `app.js`. Both are `type="module"` (deferred). The import map must precede any module scripts. `config.js` is a regular script (blocking, sets `window.__VB_CONFIG` before modules execute).

- [ ] **Step 2: Add user menu button to header**

In the `<header class="app-header">` section, after the `pageRefreshButton` (line 29-30 area), add a user menu button:

Find:
```html
          <button id="pageRefreshButton" class="refresh-button" type="button" title="刷新" aria-label="刷新页面">
```

After the closing `</button>` of `pageRefreshButton`, add:
```html
          <button id="userMenuBtn" class="icon-btn user-menu-btn hidden" type="button" title="账户" aria-label="账户菜单">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          <div id="userMenuDropdown" class="user-menu-dropdown hidden">
            <span id="userMenuEmail" class="user-menu-email"></span>
            <hr class="user-menu-divider" />
            <button id="signOutBtn" class="user-menu-action" type="button">退出登录</button>
          </div>
```

The button is `hidden` by default — auth.js shows it after login.

- [ ] **Step 3: Add auth overlay markup**

After the toast div (line 157) and before the script tags, add the auth overlay:

```html
    <!-- Auth Overlay -->
    <div id="authOverlay" class="auth-overlay">
      <div class="auth-card">
        <div class="auth-header">
          <img src="/icons/icon-192.png" alt="" class="auth-logo" width="48" height="48" />
          <h1 class="auth-title">VoiceBridge</h1>
          <p class="auth-subtitle">登录以使用跨设备语音输入</p>
        </div>
        <form id="authForm" class="auth-form" novalidate>
          <label for="authEmail" class="auth-label">邮箱</label>
          <input id="authEmail" class="auth-input" type="email" placeholder="your@email.com" required autocomplete="email" />
          <label for="authPassword" class="auth-label">密码</label>
          <input id="authPassword" class="auth-input" type="password" placeholder="至少 6 位" required autocomplete="current-password" minlength="6" />
          <button id="authSubmitBtn" class="auth-submit-btn" type="submit">登录</button>
        </form>
        <div class="auth-switch">
          <span id="authSwitchText">还没有账号？</span>
          <button id="authSwitchBtn" class="auth-switch-btn" type="button">注册</button>
        </div>
        <div id="authError" class="auth-error hidden" role="alert"></div>
        <div id="authMessage" class="auth-message hidden" role="status"></div>
      </div>
    </div>
```

- [ ] **Step 4: Verify HTML loads without JS errors**

Open `https://localhost:3000` in a browser. The auth overlay should be visible (no JS logic yet, so just static HTML). The main app panel should be visible behind it. No console errors about missing scripts.

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git commit -m "feat(ui): add auth overlay, import map, and user menu to index.html"
```

---

### Task 5: CSS — Auth Overlay & User Menu Styles

Add styles for the auth overlay and user menu dropdown, matching the existing design system (CSS variables, rounded corners, warm palette).

**Files:**
- Modify: `src/public/style.css`

- [ ] **Step 1: Append auth and user menu styles**

Append after the last line (line 1451, after the `@media (prefers-reduced-motion)` block):

```css
/* ========== Auth Overlay ========== */
.auth-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-page);
  padding: 20px;
}

.auth-card {
  width: 100%;
  max-width: 360px;
  background: var(--bg-card);
  border-radius: var(--radius-xl);
  padding: 32px 24px;
  box-shadow: var(--shadow-card);
}

.auth-header {
  text-align: center;
  margin-bottom: 24px;
}

.auth-logo {
  border-radius: 14px;
  margin-bottom: 12px;
}

.auth-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.auth-subtitle {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.auth-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 4px 0 0;
}

.auth-input {
  width: 100%;
  padding: 12px 16px;
  border: 1.5px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 1rem;
  color: var(--text-primary);
  background: var(--bg-card);
  outline: none;
  transition: border-color 0.15s ease;
  box-sizing: border-box;
}

.auth-input:focus {
  border-color: var(--accent);
}

.auth-input::placeholder {
  color: var(--text-placeholder);
}

.auth-submit-btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--accent-gradient);
  color: var(--accent-text);
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  margin-top: 4px;
  transition: opacity 0.15s ease;
}

.auth-submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.auth-submit-btn:not(:disabled):active {
  opacity: 0.85;
}

.auth-switch {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 16px;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.auth-switch-btn {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

.auth-error {
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  background: #fef2f2;
  color: #dc2626;
  font-size: 0.8125rem;
  text-align: center;
}

.auth-message {
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent-deep);
  font-size: 0.8125rem;
  text-align: center;
}

/* Dark mode auth */
@media (prefers-color-scheme: dark) {
  .auth-error {
    background: rgba(127, 29, 29, 0.2);
    color: #fca5a5;
  }
}

/* ========== User Menu ========== */
.user-menu-btn {
  position: relative;
}

.user-menu-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 100;
  min-width: 200px;
  padding: 8px 0;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-accent);
  border: 1px solid var(--border);
}

.user-menu-email {
  display: block;
  padding: 8px 16px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.user-menu-divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: 4px 0;
}

.user-menu-action {
  display: block;
  width: 100%;
  padding: 10px 16px;
  border: none;
  background: none;
  color: var(--danger);
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
}

.user-menu-action:active {
  background: var(--bg-soft);
}
```

- [ ] **Step 2: Verify styles in browser**

Open `https://localhost:3000`. The auth overlay should show a centered card with the VoiceBridge logo, email/password inputs, a gradient submit button, and a "还没有账号？注册" switch link. The user menu button should be hidden (`.hidden` class).

- [ ] **Step 3: Commit**

```bash
git add src/public/style.css
git commit -m "feat(ui): add auth overlay and user menu styles"
```

---

### Task 6: Auth Module — `auth.js`

Create the Supabase client, auth UI logic (signUp, signIn, signOut), session management, and device list query. This module dispatches a custom event (`vb:authenticated`) when the user is logged in, which `app.js` listens for.

**Files:**
- Create: `src/public/auth.js`

- [ ] **Step 1: Create auth.js with Supabase client init**

Create `src/public/auth.js`:

```javascript
import { createClient } from "@supabase/supabase-js";

// === Config ===
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.__VB_CONFIG || {};

// If no Supabase config, skip auth entirely (LAN-only mode)
const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let supabase = null;
let currentUser = null;

if (hasSupabase) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// === DOM References ===
const authOverlay = document.getElementById("authOverlay");
const authForm = document.getElementById("authForm");
const authEmail = document.getElementById("authEmail");
const authPassword = document.getElementById("authPassword");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const authError = document.getElementById("authError");
const authMessage = document.getElementById("authMessage");
const authSwitchText = document.getElementById("authSwitchText");
const authSwitchBtn = document.getElementById("authSwitchBtn");
const userMenuBtn = document.getElementById("userMenuBtn");
const userMenuDropdown = document.getElementById("userMenuDropdown");
const userMenuEmail = document.getElementById("userMenuEmail");
const signOutBtn = document.getElementById("signOutBtn");

let isSignUpMode = false;

// === Helpers ===
function showEl(el) {
  el.classList.remove("hidden");
}

function hideEl(el) {
  el.classList.add("hidden");
}

function showError(text) {
  authError.textContent = text;
  showEl(authError);
  hideEl(authMessage);
}

function showMessage(text) {
  authMessage.textContent = text;
  showEl(authMessage);
  hideEl(authError);
}

function clearMessages() {
  hideEl(authError);
  hideEl(authMessage);
}

function setLoading(loading) {
  authSubmitBtn.disabled = loading;
  authSubmitBtn.textContent = loading ? "请稍候…" : (isSignUpMode ? "注册" : "登录");
}

// === Auth Actions ===
async function handleAuth(email, password) {
  clearMessages();
  setLoading(true);

  try {
    const { data, error } = isSignUpMode
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });

    if (error) throw error;

    if (isSignUpMode && !data.session) {
      // Email confirmation required
      showMessage("注册成功！请查收邮箱中的确认链接。");
      setLoading(false);
      return;
    }

    onAuthenticated(data.user);
  } catch (err) {
    const msg = mapAuthError(err);
    showError(msg);
    setLoading(false);
  }
}

async function handleSignOut() {
  hideEl(userMenuDropdown);
  await supabase.auth.signOut();
  onSignedOut();
}

function onAuthenticated(user) {
  currentUser = user;
  hideEl(authOverlay);
  showEl(userMenuBtn);
  userMenuEmail.textContent = user.email;
  document.dispatchEvent(new CustomEvent("vb:authenticated", { detail: { user } }));
}

function onSignedOut() {
  currentUser = null;
  hideEl(userMenuBtn);
  showEl(authOverlay);
  clearMessages();
  authEmail.value = "";
  authPassword.value = "";
  authForm.reset();
}

function mapAuthError(err) {
  const msg = err.message || String(err);
  if (msg.includes("Invalid login credentials")) return "邮箱或密码不正确。";
  if (msg.includes("already registered")) return "该邮箱已注册，请直接登录。";
  if (msg.includes("Password should be at least")) return "密码至少需要 6 个字符。";
  if (msg.includes("rate limit")) return "请求过于频繁，请稍后再试。";
  return "操作失败，请重试。";
}

// === Event Bindings ===
authForm.addEventListener("submit", (e) => {
  e.preventDefault();
  handleAuth(authEmail.value.trim(), authPassword.value);
});

authSwitchBtn.addEventListener("click", () => {
  isSignUpMode = !isSignUpMode;
  authSubmitBtn.textContent = isSignUpMode ? "注册" : "登录";
  authSwitchText.textContent = isSignUpMode ? "已有账号？" : "还没有账号？";
  authSwitchBtn.textContent = isSignUpMode ? "登录" : "注册";
  clearMessages();
});

signOutBtn.addEventListener("click", handleSignOut);

userMenuBtn.addEventListener("click", () => {
  userMenuDropdown.classList.toggle("hidden");
});

// Close user menu on outside click
document.addEventListener("click", (e) => {
  if (!userMenuBtn.contains(e.target) && !userMenuDropdown.contains(e.target)) {
    hideEl(userMenuDropdown);
  }
});

// === Init ===
async function initAuth() {
  if (!hasSupabase) {
    // LAN-only mode: no auth required, let app.js init directly
    hideEl(authOverlay);
    document.dispatchEvent(new CustomEvent("vb:authenticated", { detail: { user: null } }));
    return;
  }

  // Listen for auth state changes (covers initial session restore, token refresh, sign-out)
  supabase.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      onAuthenticated(session.user);
    } else if (event === "SIGNED_OUT") {
      onSignedOut();
    }
  });

  // Check for existing session
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    onAuthenticated(session.user);
  }
  // If no session, auth overlay is already visible (no action needed)
}

initAuth();
```

Key design decisions:
- **LAN-only fallback**: If `SUPABASE_URL`/`SUPABASE_ANON_KEY` are empty, auth is skipped and app loads normally. Existing LAN users are not broken.
- **Custom event `vb:authenticated`**: Loose coupling between auth.js and app.js. No imports needed.
- **`onAuthStateChange`**: Handles session restore on reload, token refresh, and sign-out — no polling needed.
- **Email confirmation**: Supabase default. Shows a message after registration; user must click email link before logging in.

- [ ] **Step 2: Verify auth.js loads without errors**

Open `https://localhost:3000` with Supabase env vars set. Console should show no errors. Auth overlay visible. Type an email and password, click "登录" — should get error "邮箱或密码不正确。" (since no user exists yet).

- [ ] **Step 3: Commit**

```bash
git add src/public/auth.js
git commit -m "feat(auth): add Supabase auth module with login, register, sign-out"
```

---

### Task 7: App.js — Gate Initialization Behind Auth

Modify `app.js` to only initialize (WindowSelector, CommandLibrary, WebSocket) after the `vb:authenticated` event fires. In LAN-only mode (no Supabase), the event fires immediately from auth.js.

**Files:**
- Modify: `src/public/app.js:763-765`
- Modify: `src/public/app.js:1094`

- [ ] **Step 1: Wrap initialization in auth event listener**

Replace lines 763-765:
```javascript
// === Initialize ===
const windowSelector = new WindowSelector();
const commandLibrary = new CommandLibrary(document.getElementById("commandLibrary"));
```

With:
```javascript
// === Initialize (gated behind auth) ===
let windowSelector = null;
let commandLibrary = null;

document.addEventListener("vb:authenticated", () => {
  windowSelector = new WindowSelector();
  commandLibrary = new CommandLibrary(document.getElementById("commandLibrary"));
  initApp();
});

function initApp() {
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
```

- [ ] **Step 2: Move remaining initialization code into initApp()**

The existing code from line 768 onwards (text input events, button bindings, recording setup, WebSocket connection) must be moved inside `initApp()`. The current code at lines 768-1172 is all part of the module top-level execution. It needs to be wrapped.

Specifically, find all the code from line 768 (`updateTextInputState();`) through line 1172 (end of file) and wrap it inside the `initApp()` function body. The closing brace of `initApp()` should be at the very end.

The result structure:
```javascript
// line 762: end of CommandLibrary class

// === Initialize (gated behind auth) ===
let windowSelector = null;
let commandLibrary = null;

document.addEventListener("vb:authenticated", () => {
  windowSelector = new WindowSelector();
  commandLibrary = new CommandLibrary(document.getElementById("commandLibrary"));
  initApp();
});

function initApp() {
  // === Text Input Events === (was line 768)
  updateTextInputState();
  // ... ALL existing code through line 1172 ...
  connectWebSocket(); // was called at top-level, now inside initApp()
} // end of initApp()
```

**Important**: The `connectWebSocket()` call that was at the module top level (around line 1094 area, after all the function definitions) must now be the last line inside `initApp()`. All event bindings, recording setup, and function definitions remain unchanged — they just move inside `initApp()`.

- [ ] **Step 3: Verify app initializes after auth**

Open `https://localhost:3000`:
1. **With Supabase env vars set**: Auth overlay shows. Log in (or register first). After login, overlay disappears, WebSocket connects, full app loads.
2. **Without Supabase env vars**: Auth overlay hides immediately, app loads as before (LAN mode).
3. **Page reload while logged in**: Session restored from localStorage, overlay skips, app loads directly.

- [ ] **Step 4: Commit**

```bash
git add src/public/app.js
git commit -m "feat(app): gate initialization behind auth event for SaaS support"
```

---

### Task 8: Device List — Empty State Display

After login, show a "no devices connected" message in a new section below the header. This validates that the Supabase client can query the `devices` table with RLS. The Desktop Agent (Phase 4+) will register devices; for now the list is always empty.

**Files:**
- Modify: `src/public/index.html` — Add devices section HTML
- Modify: `src/public/style.css` — Add devices section styles
- Modify: `src/public/auth.js` — Add device query logic

- [ ] **Step 1: Add devices section to HTML**

In `index.html`, inside the `<div class="panel">`, after the `</section>` closing tag of `device-pill` (line 63), add:

```html
        <!-- 设备列表 -->
        <section id="devicesSection" class="devices-section hidden" aria-label="已连接设备">
          <div class="devices-header">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" stroke-width="2"/></svg>
            <span>设备</span>
          </div>
          <div id="devicesList" class="devices-list">
            <p class="devices-empty" id="devicesEmpty">暂无已连接的设备。请下载并登录桌面客户端。</p>
          </div>
        </section>
```

- [ ] **Step 2: Add devices section CSS**

Append to `style.css` (after the user menu styles from Task 5):

```css
/* ========== Devices Section ========== */
.devices-section {
  padding: 0;
}

.devices-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 4px;
  margin-bottom: 6px;
}

.devices-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.devices-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 0.8125rem;
  padding: 16px 0;
  margin: 0;
}

.device-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-chip);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}

.device-item-name {
  flex: 1;
  font-size: 0.875rem;
  color: var(--text-primary);
  font-weight: 500;
}

.device-item-status {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.device-item-status.online {
  color: #22c55e;
}
```

- [ ] **Step 3: Add device query to auth.js**

In `auth.js`, inside the `onAuthenticated` function, add a device list query. After `document.dispatchEvent(...)`:

Add to the `onAuthenticated` function:
```javascript
  // Show devices section and query devices
  if (supabase) {
    showEl(document.getElementById("devicesSection"));
    loadDevices();
  }
```

And add the `loadDevices` function (before `initAuth`):
```javascript
async function loadDevices() {
  const listEl = document.getElementById("devicesList");
  const emptyEl = document.getElementById("devicesEmpty");
  if (!supabase || !listEl) return;

  try {
    const { data: devices, error } = await supabase
      .from("devices")
      .select("id, name, platform, last_seen")
      .order("last_seen", { ascending: false });

    if (error) throw error;

    // Remove any existing device items (keep the empty message)
    listEl.querySelectorAll(".device-item").forEach(el => el.remove());

    if (devices.length === 0) {
      showEl(emptyEl);
      return;
    }

    hideEl(emptyEl);
    for (const device of devices) {
      const isOnline = device.last_seen && (Date.now() - new Date(device.last_seen).getTime()) < 60000;
      const item = document.createElement("div");
      item.className = "device-item";
      item.innerHTML = `
        <span class="device-item-name">${escapeHtml(device.name)}</span>
        <span class="device-item-status ${isOnline ? "online" : ""}">${isOnline ? "在线" : "离线"}</span>
      `;
      listEl.appendChild(item);
    }
  } catch (err) {
    console.error("Failed to load devices:", err);
  }
}

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}
```

- [ ] **Step 4: Verify device list**

Open `https://localhost:3000`, log in. After the auth overlay disappears, a "设备" section should appear below the header showing "暂无已连接的设备。请下载并登录桌面客户端。" The Supabase query should succeed (return empty array, no errors in console).

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html src/public/style.css src/public/auth.js
git commit -m "feat(devices): add device list section with empty state and Supabase query"
```

---

### Task 9: End-to-End Verification

Manual browser testing to validate the complete Phase 1 milestone.

- [ ] **Step 1: Test full registration flow**

1. Open `https://localhost:3000` (with Supabase env vars)
2. Auth overlay visible with "登录" button
3. Click "注册" — form switches to registration mode, button says "注册"
4. Enter email + password (6+ chars), click "注册"
5. Expected: "注册成功！请查收邮箱中的确认链接。"
6. Click confirmation link in email
7. Back to app, enter same email + password, click "登录"
8. Expected: Auth overlay disappears, user menu button visible in header, device list shows "暂无已连接的设备"

- [ ] **Step 2: Test session persistence**

1. Reload the page (F5)
2. Expected: No auth overlay — app loads directly with user logged in
3. User menu shows email, has "退出登录" option

- [ ] **Step 3: Test sign-out flow**

1. Click user menu button → dropdown shows email + "退出登录"
2. Click "退出登录"
3. Expected: Auth overlay reappears, user menu hidden, form reset
4. Reload page: auth overlay still shown (session cleared)

- [ ] **Step 4: Test LAN-only fallback**

1. Remove `SUPABASE_URL` and `SUPABASE_ANON_KEY` from `.env`
2. Restart server
3. Open `https://localhost:3000`
4. Expected: No auth overlay, app loads normally (LAN mode preserved)

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(auth): end-to-end testing fixes for Phase 1 auth flow"
```

---

## Self-Review Checklist

### Spec Coverage
| Spec requirement | Plan task | Status |
|---|---|---|
| Supabase project setup | Task 1 (deps), Task 3 (schema) | Covered |
| Email + password auth | Task 6 (auth.js) | Covered |
| Registration with email confirmation | Task 6 (auth.js signUp + message) | Covered |
| Session persistence across reloads | Task 6 (onAuthStateChange + getSession) | Covered |
| DB schema (devices, commands, transcriptions) | Task 3 (migration) | Covered |
| RLS policies | Task 3 (migration SQL) | Covered |
| Empty device list display | Task 8 (device list section) | Covered |
| Authenticated state visible to user | Task 4 (user menu), Task 6 | Covered |
| LAN mode not broken | Task 6 (hasSupabase fallback), Task 9 Step 4 | Covered |

### Placeholder Scan
- No "TBD", "TODO", "implement later", "fill in details" found
- No "Similar to Task N" — all code is inline
- All steps have actual code, commands, or exact file changes
- No "add appropriate error handling" — error handling is explicit (`mapAuthError`, try/catch)

### Type/Name Consistency
- `supabase` variable: consistent across auth.js
- `authOverlay`, `authForm`, `authEmail`, `authPassword`, `authSubmitBtn`: consistent between HTML ids, CSS selectors, and JS references
- `vb:authenticated` event: used consistently in auth.js (dispatch) and app.js (listen)
- `window.__VB_CONFIG`: consistent between server endpoint and auth.js
- `devicesSection`, `devicesList`, `devicesEmpty`: consistent between HTML and JS

### Potential Issues
1. **Import map browser support**: Requires Safari 16.4+ (iOS 16.4+, March 2023), Chrome 89+, Firefox 108+. All supported.
2. **esm.sh CDN dependency**: If CDN is down, auth won't load. Acceptable for Phase 1; can self-host bundle later.
3. **Email confirmation friction**: Users must check email before first login. This is Supabase default and appropriate for production. Can be disabled in Supabase Dashboard for development testing.
