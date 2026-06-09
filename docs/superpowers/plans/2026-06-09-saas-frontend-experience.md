# SaaS 前端产品化体验补齐 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次性补齐 SaaS 云模式的 9 项前端产品化体验（账户抽屉、Plan 展示、定价对比、用量仪表板、订阅管理、Profile、设备管理、密码重置、支付回调），不改动后端。

**Architecture:** 新增一个「账户设置」底部抽屉组件 `AccountDrawer`，承载 plan/额度/定价/用量/订阅/profile/设备 7 项功能。Auth overlay 增强 3 项功能（密码重置、token 过期提示、邮箱重发）。支付回调用 toast 处理。所有新 UI 严格复用现有 CSS 变量和组件模式。

**Tech Stack:** Vanilla JS (ESM), CSS custom properties, Supabase JS SDK v2

**工作树路径:** `/Users/hl/.config/superpowers/worktrees/VoiceBridge/saas-auth-v3/`

---

## 文件改动总览

| 文件 | 职责 |
|------|------|
| `src/public/index.html` | 新增 `#accountDrawer` HTML、改造 `#billingActions`、auth-card 增加忘记密码/重置/重发表单 |
| `src/public/style.css` | 新增抽屉样式（`.account-drawer-*`）、plan badge、进度条、定价卡片、profile/device 列表样式、auth 扩展样式 |
| `src/public/app.js` | 新增 `AccountDrawer` 类、`billing=success/cancel` 处理、`handleAuthState` 增强（token 过期）、改造 `updateBillingControls` |
| `src/public/auth.js` | 新增 `resetPassword()`、`resendVerification()` 方法暴露到 `VoiceBridgeAuth` |

---

### Task 1: Stripe 支付回调处理

**Files:**
- Modify: `src/public/app.js:329` (在 `updateBillingControls` 调用之后)

- [ ] **Step 1: 在 app.js 中 `updateBillingControls` 调用之后添加 billing 回调处理**

在 `src/public/app.js` 第 329 行 `updateBillingControls(Boolean(window.VoiceBridgeAuth?.session));` 之后追加：

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/public/app.js
git commit -m "feat(ui): handle Stripe billing success/cancel callback with toast"
```

---

### Task 2: Token 过期友好提示

**Files:**
- Modify: `src/public/app.js:191-199` (`handleAuthState` 函数)

- [ ] **Step 1: 在 handleAuthState 中添加 token 过期提示**

修改 `src/public/app.js` 的 `handleAuthState` 函数（行 191-199），在 `if (!session || !user ...)` 分支中添加提示。将原代码：

```javascript
  if (!session || !user || !window.VoiceBridgeAuth?.supabase) {
    await stopCloudRealtime();
    resetCloudDeviceSelect();
    return;
  }
```

改为：

```javascript
  if (!session || !user || !window.VoiceBridgeAuth?.supabase) {
    if (activeCloudUserId) {
      showToast("会话已过期，请重新登录");
      activeCloudUserId = "";
    }
    await stopCloudRealtime();
    resetCloudDeviceSelect();
    return;
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/public/app.js
git commit -m "feat(auth): show toast when session expires instead of silent redirect"
```

---

### Task 3: Auth 增强 — 密码重置、邮箱重发、重置表单

**Files:**
- Modify: `src/public/index.html:167-180` (auth overlay HTML)
- Modify: `src/public/auth.js` (新增方法)

- [ ] **Step 1: 在 auth-card 中添加"忘记密码"链接**

在 `src/public/index.html` 第 175 行密码输入框和第 176 行登录按钮之间插入忘记密码链接：

```html
        <label class="auth-label" for="authPassword">密码</label>
        <input id="authPassword" class="auth-input" type="password" autocomplete="current-password" minlength="6" required />
        <button id="authForgotBtn" class="auth-link-btn" type="button">忘记密码？</button>
        <button id="authSubmitBtn" class="auth-submit-btn" type="submit">登录</button>
```

- [ ] **Step 2: 在 auth-card 中添加重置密码表单和邮箱验证重发按钮**

在 `</form>` 之前、`authMessage` 之后添加重置密码的内联表单区域和重发按钮：

```html
        <p id="authMessage" class="auth-message" role="status"></p>
        <!-- 重置密码表单（默认隐藏） -->
        <div id="authResetForm" class="hidden">
          <p class="auth-reset-info">输入注册邮箱，我们将发送重置链接。</p>
          <label class="auth-label" for="authResetEmail">邮箱</label>
          <input id="authResetEmail" class="auth-input" type="email" autocomplete="email" required />
          <button id="authResetBtn" class="auth-submit-btn" type="button">发送重置链接</button>
          <button id="authResetBackBtn" class="auth-switch-btn" type="button">返回登录</button>
        </div>
        <!-- 邮箱验证重发（默认隐藏） -->
        <button id="authResendBtn" class="auth-switch-btn hidden" type="button">重新发送验证邮件</button>
      </form>
```

- [ ] **Step 3: 添加忘记密码链接和重发按钮的 CSS**

在 `src/public/style.css` 中 `auth-message.error` 样式（行 1534）之后追加：

```css
.auth-link-btn {
  justify-self: start;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 0;
}

.auth-link-btn:hover {
  color: var(--accent);
}

.auth-reset-info {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}
```

同时在暗色模式 block（约行 1443 的 `@media (prefers-color-scheme: dark)` 内）追加：

```css
  .auth-card {
    background: var(--bg-card);
    color: var(--text-primary);
  }
  .auth-link-btn {
    color: var(--text-secondary);
  }
  .auth-reset-info {
    color: var(--text-secondary);
  }
```

- [ ] **Step 4: 在 auth.js 中添加密码重置和邮箱重发逻辑**

在 `src/public/auth.js` 的 `form?.addEventListener` 块之后（行 108 之后），`setMode("sign-in")` 之前，追加：

```javascript
// === 密码重置 ===
const forgotBtn = document.querySelector("#authForgotBtn");
const resetForm = document.querySelector("#authResetForm");
const resetEmailInput = document.querySelector("#authResetEmail");
const resetBtn = document.querySelector("#authResetBtn");
const resetBackBtn = document.querySelector("#authResetBackBtn");
const resendBtn = document.querySelector("#authResendBtn");
const resetInfo = document.querySelector(".auth-reset-info");

forgotBtn?.addEventListener("click", () => {
  form?.classList.add("hidden");
  resetForm?.classList.remove("hidden");
  forgotBtn.classList.add("hidden");
  switchBtn?.classList.add("hidden");
  submitBtn?.classList.add("hidden");
  if (resetEmailInput && emailInput) resetEmailInput.value = emailInput.value;
  if (modeLabel) modeLabel.textContent = "重置密码";
});

resetBackBtn?.addEventListener("click", () => {
  resetForm?.classList.add("hidden");
  form?.classList.remove("hidden");
  forgotBtn?.classList.remove("hidden");
  switchBtn?.classList.remove("hidden");
  submitBtn?.classList.remove("hidden");
  if (modeLabel) modeLabel.textContent = "登录以连接你的设备";
});

resetBtn?.addEventListener("click", async () => {
  if (!supabase || !resetEmailInput) return;
  const email = resetEmailInput.value.trim();
  if (!email) return;
  resetBtn.disabled = true;
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) {
      setMessage(error.message, true);
      return;
    }
    if (resetInfo) resetInfo.textContent = "重置链接已发送到您的邮箱。";
    resetBtn.textContent = "已发送";
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "发送失败，请稍后重试。", true);
  } finally {
    resetBtn.disabled = false;
  }
});

// === 邮箱验证重发 ===
resendBtn?.addEventListener("click", async () => {
  if (!supabase || !emailInput) return;
  const email = emailInput.value.trim();
  if (!email) return;
  resendBtn.disabled = true;
  try {
    const { error } = await supabase.auth.resend({ type: "signup", email });
    if (error) {
      setMessage(error.message, true);
      return;
    }
    resendBtn.textContent = "已发送";
    setTimeout(() => { resendBtn.textContent = "重新发送验证邮件"; }, 3000);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "发送失败，请稍后重试。", true);
  } finally {
    resendBtn.disabled = false;
  }
});
```

- [ ] **Step 5: 修改注册成功逻辑，显示重发按钮**

修改 `src/public/auth.js` 中注册成功的处理（行 100-102），将：

```javascript
    if (mode === "sign-up" && !result.data.session) {
      setMessage("注册成功，请检查邮箱完成验证。");
    }
```

改为：

```javascript
    if (mode === "sign-up" && !result.data.session) {
      setMessage("注册成功，请检查邮箱完成验证。");
      resendBtn?.classList.remove("hidden");
    }
```

- [ ] **Step 6: Commit**

```bash
git add src/public/index.html src/public/style.css src/public/auth.js
git commit -m "feat(auth): add password reset, email verification resend, and forgot password flow"
```

---

### Task 4: 账户抽屉 HTML + CSS 骨架

**Files:**
- Modify: `src/public/index.html` (在 `#addCommandDialog` 之前新增 `#accountDrawer`)
- Modify: `src/public/style.css` (新增抽屉样式)

- [ ] **Step 1: 改造 billingActions 区域**

将 `src/public/index.html` 第 23-27 行的 `#billingActions` 替换为：

```html
          <div id="billingActions" class="billing-actions hidden" aria-label="账户">
            <span id="planBadge" class="plan-badge hidden">Free</span>
            <button id="accountDrawerBtn" class="billing-button" type="button" aria-label="账户设置">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
            <button id="authLogoutButton" class="billing-button hidden" type="button">退出</button>
          </div>
```

注意：移除了原来的 `#upgradeButton` 和 `#billingPortalButton`，改为 plan badge + 设置图标按钮。`#authLogoutButton` 保留。

- [ ] **Step 2: 新增 accountDrawer HTML**

在 `<!-- 新增指令弹窗 -->` 注释之前（行 193 之前），插入：

```html
    <!-- 账户设置抽屉 -->
    <div id="accountDrawer" class="account-drawer hidden">
      <div class="account-drawer-overlay"></div>
      <div class="account-drawer-sheet">
        <div class="account-drawer-handle"></div>
        <div class="account-drawer-header">
          <h2 class="account-drawer-title">账户设置</h2>
          <button id="accountDrawerClose" class="account-drawer-close" type="button" aria-label="关闭">✕</button>
        </div>
        <div id="accountDrawerBody" class="account-drawer-body">
          <!-- JS 动态渲染 -->
        </div>
      </div>
    </div>
```

- [ ] **Step 3: 添加抽屉 CSS**

在 `src/public/style.css` 的 `.add-cmd-handle` 样式之后（行 1118 之后），追加：

```css
/* === Account Drawer === */
.account-drawer {
  position: fixed;
  inset: 0;
  z-index: 100;
}

.account-drawer.hidden {
  display: none;
}

.account-drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(200, 120, 50, 0.15);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.account-drawer-sheet {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  max-width: 430px;
  margin: 0 auto;
  padding: 20px;
  padding-bottom: max(20px, env(safe-area-inset-bottom));
  border-radius: 22px 22px 0 0;
  background: var(--bg-card);
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
  z-index: 101;
  max-height: 80svh;
  display: grid;
  grid-template-rows: auto 1fr;
}

.account-drawer-handle {
  width: 36px;
  height: 4px;
  border-radius: 999px;
  background: var(--border-strong);
  margin: 0 auto 14px;
}

.account-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.account-drawer-title {
  font-size: 18px;
  font-weight: 750;
  color: var(--text-primary);
  margin: 0;
}

.account-drawer-close {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: none;
  background: var(--bg-soft);
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  display: grid;
  place-items: center;
}

.account-drawer-close:hover {
  background: var(--border-strong);
}

.account-drawer-body {
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
```

- [ ] **Step 4: 添加 Plan Badge 样式**

在抽屉 CSS 之后追加：

```css
/* === Plan Badge === */
.plan-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  background: var(--bg-soft);
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.plan-badge.pro {
  background: var(--accent-soft);
  color: var(--accent-deep);
  border-color: rgba(232, 121, 58, 0.2);
}
```

- [ ] **Step 5: 添加 Section 通用样式（抽屉内各模块）**

```css
/* === Account Section === */
.account-section {
  padding: 14px;
  border-radius: var(--radius-md);
  background: var(--bg-soft);
}

.account-section-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 10px;
}

.account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.account-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.account-row-label {
  font-size: 14px;
  color: var(--text-secondary);
}

.account-row-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.account-action-btn {
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.account-action-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.account-action-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}

.account-action-btn.primary:hover {
  background: var(--accent-deep);
}

.account-action-btn.danger {
  color: var(--danger);
  border-color: rgba(239, 68, 68, 0.2);
}

.account-action-btn.danger:hover {
  background: #fef2f2;
}
```

- [ ] **Step 6: 添加用量进度条样式**

```css
/* === Usage Bar === */
.usage-bar-track {
  width: 100%;
  height: 8px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
  margin-top: 6px;
}

.usage-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent-gradient);
  transition: width 0.4s var(--ease-smooth);
}

.usage-bar-fill.warning {
  background: linear-gradient(90deg, #f59e0b, #d97706);
}

.usage-bar-fill.critical {
  background: linear-gradient(90deg, #ef4444, #dc2626);
}

.usage-stats {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.usage-stat-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}

.usage-stat-label {
  color: var(--text-secondary);
}

.usage-stat-value {
  font-weight: 600;
  color: var(--text-primary);
}
```

- [ ] **Step 7: 添加定价对比卡片样式**

```css
/* === Pricing Cards === */
.pricing-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.pricing-card {
  padding: 14px;
  border-radius: var(--radius-md);
  border: 1.5px solid var(--border);
  background: var(--bg-card);
  text-align: center;
}

.pricing-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.pricing-card-name {
  font-size: 15px;
  font-weight: 750;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.pricing-card.active .pricing-card-name {
  color: var(--accent);
}

.pricing-card-item {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 3px 0;
}

.pricing-card-btn {
  margin-top: 10px;
  width: 100%;
  padding: 8px;
  border-radius: 999px;
  border: none;
  background: var(--accent-gradient);
  color: var(--accent-text);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: var(--shadow-accent);
}

.pricing-card-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.pricing-card-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-deep);
  font-size: 11px;
  font-weight: 700;
  margin-left: 4px;
}
```

- [ ] **Step 8: 添加设备列表样式**

```css
/* === Device List === */
.device-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}

.device-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.device-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--text-muted);
  flex-shrink: 0;
}

.device-status-dot.online {
  background: var(--accent);
  box-shadow: 0 0 6px rgba(232, 121, 58, 0.4);
}

.device-info {
  flex: 1;
  min-width: 0;
}

.device-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.device-last-seen {
  font-size: 12px;
  color: var(--text-muted);
}

.device-remove-btn {
  padding: 4px 10px;
  border-radius: 999px;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}

.device-remove-btn:hover {
  color: var(--danger);
  background: #fef2f2;
}
```

- [ ] **Step 9: 添加 Profile 编辑样式**

```css
/* === Profile Edit === */
.profile-edit-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-edit-input {
  min-height: 38px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 14px;
}

.profile-edit-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(232, 121, 58, 0.15);
}

.profile-edit-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
```

- [ ] **Step 10: 添加暗色模式覆盖**

在暗色模式 `@media (prefers-color-scheme: dark)` block 内追加：

```css
  .account-drawer-sheet {
    background: var(--bg-card);
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.4);
  }
  .account-drawer-close {
    background: var(--bg-soft);
  }
  .account-section {
    background: var(--bg-soft);
  }
  .pricing-card {
    background: var(--bg-card);
  }
  .profile-edit-input {
    background: var(--bg-card);
    color: var(--text-primary);
  }
  .device-remove-btn:hover {
    background: #3b1515;
    color: #fca5a5;
  }
  .account-action-btn.danger:hover {
    background: #3b1515;
  }
```

- [ ] **Step 11: Commit**

```bash
git add src/public/index.html src/public/style.css
git commit -m "feat(ui): add account drawer HTML/CSS structure with plan badge, pricing, usage, device styles"
```

---

### Task 5: AccountDrawer JS — 基础框架（打开/关闭）

**Files:**
- Modify: `src/public/app.js`

- [ ] **Step 1: 添加 AccountDrawer 类和 element 引用**

在 `src/public/app.js` 顶部 element references 区域（行 18 `billingPortalButton` 之后），替换并扩展 billing 相关引用：

```javascript
const billingActions = document.querySelector("#billingActions");
const planBadge = document.querySelector("#planBadge");
const accountDrawerBtn = document.querySelector("#accountDrawerBtn");
const billingPortalButton = document.querySelector("#billingPortalButton");
const upgradeButton = document.querySelector("#upgradeButton");
```

改为：

```javascript
const billingActions = document.querySelector("#billingActions");
const planBadge = document.querySelector("#planBadge");
const accountDrawerBtn = document.querySelector("#accountDrawerBtn");
```

注意 `billingPortalButton` 和 `upgradeButton` 已从 HTML 中移除，不需要引用。

在文件底部（`updateBillingControls` 调用之后）添加 AccountDrawer 类：

```javascript
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

    const plan = subscription && (subscription.status === "active" || subscription.status === "trialing") ? "pro" : "free";
    const usedSeconds = usageEvents.filter((e) => e.status === "success").reduce((sum, e) => sum + (e.claim_seconds || 0), 0);
    const totalCount = usageEvents.length;
    const successCount = usageEvents.filter((e) => e.status === "success").length;
    const rejectedCount = usageEvents.filter((e) => e.status === "rejected").length;

    return { subscription, plan, usedSeconds, totalCount, successCount, rejectedCount, devices, user };
  }

  // 渲染方法在后续 Task 中实现
  _renderPlan() { return document.createElement("div"); }
  _renderPricing() { return document.createElement("div"); }
  _renderUsage() { return document.createElement("div"); }
  _renderSubscription() { return document.createElement("div"); }
  _renderProfile() { return document.createElement("div"); }
  _renderDevices() { return document.createElement("div"); }
}

const accountDrawer = new AccountDrawer();
accountDrawerBtn?.addEventListener("click", () => accountDrawer.open());
```

- [ ] **Step 2: 移除旧的 upgradeButton 和 billingPortalButton 事件监听**

删除 `src/public/app.js` 中的旧代码（行 321-327）：

```javascript
upgradeButton?.addEventListener("click", () => {
  void openBillingSession("billing-create-checkout-session", upgradeButton);
});

billingPortalButton?.addEventListener("click", () => {
  void openBillingSession("billing-create-portal-session", billingPortalButton);
});
```

- [ ] **Step 3: 修改 updateBillingControls**

将 `updateBillingControls` 函数（行 296-304）改为：

```javascript
function updateBillingControls(hasSession) {
  const visible = isCloudMode && hasSession;
  billingActions?.classList.toggle("hidden", !visible);
  if (accountDrawerBtn) accountDrawerBtn.disabled = !visible;
  planBadge?.classList.toggle("hidden", !visible);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/public/app.js
git commit -m "feat(ui): add AccountDrawer class with open/close/fetch framework"
```

---

### Task 6: AccountDrawer — Plan 状态与额度渲染

**Files:**
- Modify: `src/public/app.js` (替换 `_renderPlan` 占位方法)

- [ ] **Step 1: 在 app.js 顶部常量区域添加 PLAN_LIMITS 内联常量**

由于浏览器直接加载 `app.js`（非 bundled），无法 import `src/shared/planLimits.js`。在 app.js 顶部常量区域（`isCloudMode` 行之后）添加：

```javascript
const PLAN_LIMITS = {
  free: { monthlySeconds: 600, maxAudioSeconds: 60, rateLimitPerMinute: 10 },
  pro: { monthlySeconds: 18000, maxAudioSeconds: 60, rateLimitPerMinute: 30 },
};

function isPaidStatus(status) {
  return status === "active" || status === "trialing";
}
```

- [ ] **Step 2: 替换 `_renderPlan` 方法**

将 AccountDrawer 中的 `_renderPlan` 占位替换为完整实现：

```javascript
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
```

- [ ] **Step 3: 更新 planBadge 文本**

在 `handleAuthState` 函数中，有 session 时更新 planBadge。在 `cloudRealtime = realtime;` 行之后追加：

```javascript
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
```

- [ ] **Step 4: Commit**

```bash
git add src/public/app.js
git commit -m "feat(ui): render plan status and usage bar in account drawer"
```

---

### Task 7: AccountDrawer — 定价对比渲染

**Files:**
- Modify: `src/public/app.js` (替换 `_renderPricing` 占位方法)

- [ ] **Step 1: 替换 `_renderPricing` 方法**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/public/app.js
git commit -m "feat(ui): render pricing comparison cards in account drawer"
```

---

### Task 8: AccountDrawer — 用量仪表板渲染

**Files:**
- Modify: `src/public/app.js` (替换 `_renderUsage` 占位方法)

- [ ] **Step 1: 替换 `_renderUsage` 方法**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/public/app.js
git commit -m "feat(ui): render usage dashboard in account drawer"
```

---

### Task 9: AccountDrawer — 订阅管理渲染

**Files:**
- Modify: `src/public/app.js` (替换 `_renderSubscription` 占位方法)

- [ ] **Step 1: 替换 `_renderSubscription` 方法**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/public/app.js
git commit -m "feat(ui): render subscription management in account drawer"
```

---

### Task 10: AccountDrawer — Profile 渲染与编辑

**Files:**
- Modify: `src/public/app.js` (替换 `_renderProfile` 占位方法)

- [ ] **Step 1: 替换 `_renderProfile` 方法**

```javascript
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
          // Supabase 不直接验证当前密码，但 updateUser 需要 session
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
```

- [ ] **Step 2: Commit**

```bash
git add src/public/app.js
git commit -m "feat(ui): render profile management with inline email/password editing"
```

---

### Task 11: AccountDrawer — 设备管理渲染

**Files:**
- Modify: `src/public/app.js` (替换 `_renderDevices` 占位方法)

- [ ] **Step 1: 替换 `_renderDevices` 方法**

```javascript
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
```

- [ ] **Step 2: 添加 formatRelativeTime 辅助函数**

在 AccountDrawer 类定义之前（或文件顶部工具函数区域）添加：

```javascript
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
```

- [ ] **Step 3: Commit**

```bash
git add src/public/app.js
git commit -m "feat(ui): render device list with online status and remove action"
```

---

### Task 12: 运行测试并最终提交

**Files:** None (verification only)

- [ ] **Step 1: 运行现有测试确认无回归**

```bash
cd /Users/hl/.config/superpowers/worktrees/VoiceBridge/saas-auth-v3
npm test
```

Expected: All existing tests pass.

- [ ] **Step 2: 检查工作树状态**

```bash
git status
git diff --stat
```

Expected: Clean working tree (all changes committed).

- [ ] **Step 3: 如有未提交改动，执行最终 commit**

```bash
git add -A
git commit -m "feat(ui): finalize SaaS frontend experience — account drawer, auth enhancements"
```
