# Dopamine Visual Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade VoiceBridge frontend from "warm minimalist" to "Apple-quality dopamine" visual style — warm orange palette, subtle gradient background, refined card shadows, and Apple-level micro-interactions.

**Architecture:** CSS-only visual upgrade. All changes confined to `src/public/style.css` through CSS variable overrides and selector updates. No HTML structure changes, no JS logic changes. Dark mode gets parallel variable updates.

**Tech Stack:** Pure CSS (variables, gradients, transitions, backdrop-filter)

**Design Spec:** `docs/superpowers/specs/2026-05-26-dopamine-visual-design.md`

---

### Task 1: Update CSS Design Tokens (Color Variables)

**Files:**
- Modify: `src/public/style.css:2-30` (`:root` block)

- [ ] **Step 1: Replace `:root` color variables**

Replace lines 2-30 with the following. This changes the color system from green-accent to warm-orange-accent, adds new variables for gradients and micro-interaction curves:

```css
/* === Design Tokens === */
:root {
  --bg-page: #fffbf5;
  --bg-card: #ffffff;
  --bg-soft: #fff5eb;
  --bg-chip: #fef9f4;
  --text-primary: #1c1917;
  --text-secondary: #78716c;
  --text-muted: #a8a29e;
  --text-placeholder: #c7bfb8;
  --border: rgba(0, 0, 0, 0.06);
  --border-strong: rgba(0, 0, 0, 0.1);
  --accent: #e8793a;
  --accent-deep: #c2410c;
  --accent-soft: #fff5eb;
  --accent-softer: #fef9f4;
  --accent-gradient: linear-gradient(135deg, #f97316, #ea580c);
  --accent-glow: rgba(232, 121, 58, 0.35);
  --accent-text: #ffffff;
  --danger: #ef4444;
  --danger-text: #ffffff;
  --shadow-card: 0 2px 12px rgba(200, 120, 50, 0.08), 0 1px 3px rgba(0, 0, 0, 0.04);
  --shadow-button: 0 1px 4px rgba(0, 0, 0, 0.04), 0 0 0 1px rgba(0, 0, 0, 0.06);
  --shadow-button-hover: 0 4px 14px rgba(200, 120, 50, 0.12), 0 1px 4px rgba(0, 0, 0, 0.06);
  --shadow-accent: 0 2px 10px rgba(232, 121, 58, 0.3);
  --shadow-accent-lg: 0 4px 16px rgba(232, 121, 58, 0.35);
  --radius-xl: 28px;
  --radius-lg: 22px;
  --radius-md: 18px;
  --radius-sm: 14px;
  --gap: clamp(6px, 0.9svh, 10px);
  --ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
  background: linear-gradient(165deg, #fffbf5 0%, #fff5eb 40%, #fef7f0 100%);
  background-attachment: fixed;
  color: var(--text-primary);
}
```

Key changes:
- `--bg-page` → `#fffbf5` (warm white)
- `--bg-soft` → `#fff5eb` (orange tint)
- `--border` → `rgba(0,0,0,0.06)` (softer, borderless feel)
- `--accent` → `#e8793a` (warm orange)
- `--shadow-card` → warm-tinted shadow
- `--shadow-button` → lighter with border effect
- New vars: `--accent-gradient`, `--accent-glow`, `--accent-softer`, `--ease-bounce`, `--ease-smooth`, `--shadow-accent`, `--shadow-button-hover`
- `background` → subtle gradient with `background-attachment: fixed` to prevent scrolling artifact
- Font stack adds "SF Pro Display"

- [ ] **Step 2: Verify in browser**

Open `http://localhost:3000` (or your dev server). Confirm:
- Page has a subtle warm gradient background (not flat)
- Text colors are slightly warmer
- Borders appear softer/more transparent

- [ ] **Step 3: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): update design tokens to warm orange palette"
```

---

### Task 2: Update Body Background

**Files:**
- Modify: `src/public/style.css:43-49` (body rule)

- [ ] **Step 1: Update body background to use gradient**

Replace the `body` rule background line. The `body` must use the same gradient as `:root` for full-viewport coverage:

```css
body {
  margin: 0;
  min-height: 100vh;
  min-height: 100svh;
  background: linear-gradient(165deg, #fffbf5 0%, #fff5eb 40%, #fef7f0 100%);
  background-attachment: fixed;
  -webkit-tap-highlight-color: transparent;
}
```

The `background-attachment: fixed` ensures the gradient stays fixed when content scrolls within the shell.

- [ ] **Step 2: Verify gradient fills viewport**

Scroll the page. The gradient background should not tile or shift.

- [ ] **Step 3: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): apply gradient background to body"
```

---

### Task 3: Update Header — Brand Mark & Refresh Button

**Files:**
- Modify: `src/public/style.css:101-150` (brand-mark, brand, refresh-button)

- [ ] **Step 1: Update brand mark to use gradient background**

Replace `.brand-mark` (lines 101-110):

```css
.brand-mark {
  width: clamp(28px, 4.2svh, 38px);
  height: clamp(28px, 4.2svh, 38px);
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: var(--accent-gradient);
  color: var(--accent-text);
  box-shadow: var(--shadow-accent);
}
```

- [ ] **Step 2: Update refresh button with soft tint background**

Replace `.refresh-button` (lines 130-150):

```css
.refresh-button {
  width: clamp(30px, 4.2svh, 40px);
  height: clamp(30px, 4.2svh, 40px);
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  cursor: pointer;
  transition: background 0.2s var(--ease-smooth), transform 0.2s var(--ease-bounce);
}

.refresh-button:active {
  transform: scale(0.9);
}

.refresh-button svg {
  width: 26px;
  height: 26px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
```

- [ ] **Step 3: Verify header looks right**

Brand icon should be warm orange gradient with glow. Refresh button should have light orange tint background, orange icon, and bouncy press.

- [ ] **Step 4: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): brand mark gradient + refresh button tint"
```

---

### Task 4: Update Device Pill & Status Elements

**Files:**
- Modify: `src/public/style.css:153-241` (device-pill through status-badge)

- [ ] **Step 1: Update device pill background and border**

Replace `.device-pill` (lines 153-166):

```css
.device-pill {
  min-height: clamp(44px, 6svh, 58px);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: clamp(5px, 1.5vw, 10px);
  padding: 6px clamp(8px, 2vw, 12px);
  border: 1px solid rgba(232, 121, 58, 0.12);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
  box-shadow: var(--shadow-card);
  flex: 0 0 auto;
  min-width: 0;
}
```

- [ ] **Step 2: Update device icon to use gradient**

Replace `.device-icon` (lines 168-177):

```css
.device-icon {
  width: clamp(34px, 5svh, 46px);
  height: clamp(34px, 5svh, 46px);
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--accent-gradient);
  color: var(--accent-text);
  box-shadow: var(--shadow-accent);
}
```

- [ ] **Step 3: Update status dot connected glow**

Replace `.status-dot.connected` (lines 200-202):

```css
.status-dot.connected {
  background: var(--accent);
  box-shadow: 0 0 6px rgba(232, 121, 58, 0.4);
}
```

- [ ] **Step 4: Update status badge to warm orange**

Replace `.status-badge` (lines 219-229):

```css
.status-badge {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid rgba(232, 121, 58, 0.15);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-deep);
  font-size: clamp(11px, 1.4svh, 13px);
  font-weight: 650;
  white-space: nowrap;
}
```

- [ ] **Step 5: Verify device pill renders correctly**

The pill should have a warm tint border, gradient icon, glowing status dot, and orange-tinted badge.

- [ ] **Step 6: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): device pill, icon, status dot, badge warm orange"
```

---

### Task 5: Update Input Card & Window Dropdown

**Files:**
- Modify: `src/public/style.css:442-454` (input-card), `283-296` (window-dropdown)

- [ ] **Step 1: Update input card for refined card feel**

Replace `.input-card` (lines 443-454):

```css
.input-card {
  min-height: clamp(96px, 13svh, 132px);
  display: flex;
  flex-direction: column;
  padding: clamp(10px, 1.6svh, 16px);
  border: 1px solid rgba(255, 255, 255, 0.8);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
  box-shadow: var(--shadow-card);
  flex: 0 0 auto;
  min-width: 0;
  transition: box-shadow 0.3s var(--ease-smooth);
}

.input-card:focus-within {
  box-shadow: var(--shadow-button-hover);
}
```

The `:focus-within` adds a subtle shadow lift when the user is typing.

- [ ] **Step 2: Update window dropdown shadow**

Replace `.window-dropdown` (lines 283-296), changing only the box-shadow line:

```css
.window-dropdown {
  position: absolute;
  top: calc(100% + 12px);
  left: 0;
  width: min(320px, calc(100vw - 28px));
  max-height: min(340px, 55svh);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  box-shadow: 0 14px 34px rgba(200, 120, 50, 0.12), 0 4px 12px rgba(0, 0, 0, 0.06);
  flex-direction: column;
  z-index: 100;
  overflow: hidden;
}
```

- [ ] **Step 3: Update window item hover/selected to warm tint**

Replace `.window-item:hover, .window-item.selected` (lines 348-352):

```css
.window-item:hover,
.window-item.selected {
  background: var(--accent-soft);
  color: var(--accent-deep);
}
```

(These already use CSS variables, so the change from Task 1 handles it. No actual edit needed here — just verify it looks right.)

- [ ] **Step 4: Verify input card and dropdown look refined**

- [ ] **Step 5: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): input card refined shadow + dropdown warm tint"
```

---

### Task 6: Update Recent Commands Tags

**Files:**
- Modify: `src/public/style.css:410-440` (recent-bar, recent-tag)

- [ ] **Step 1: Update recent tag to white card style**

Replace `.recent-tag` (lines 419-434):

```css
.recent-tag {
  max-width: 120px;
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-shadow: var(--shadow-button);
  cursor: pointer;
  transition: all 0.2s var(--ease-bounce);
}
```

- [ ] **Step 2: Update active state with bounce**

Replace `.recent-tag:active` (lines 436-440):

```css
.recent-tag:active {
  transform: scale(0.94);
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-text);
  box-shadow: var(--shadow-accent);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): recent tags white card + bouncy press"
```

---

### Task 7: Update Side Action Buttons (Paste/Undo/Enter)

**Files:**
- Modify: `src/public/style.css:505-535` (side-action-btn), `746-752` (active state)

- [ ] **Step 1: Update side action buttons**

Replace `.side-action-btn` (lines 505-524):

```css
.side-action-btn {
  flex: 1 1 0;
  min-width: 0;
  min-height: clamp(48px, 7svh, 64px);
  max-width: 76px;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 6px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: clamp(11px, 1.5svh, 14px);
  font-weight: 650;
  box-shadow: var(--shadow-button);
  cursor: pointer;
  transition: all 0.2s var(--ease-bounce);
}

.side-action-btn:hover {
  box-shadow: var(--shadow-button-hover);
}
```

- [ ] **Step 2: Update active state for all buttons**

Replace the combined `:active` rule (lines 746-752):

```css
.quick-btn:active,
.terminal-btn:active,
.side-action-btn:active {
  transform: scale(0.92);
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-text);
  box-shadow: var(--shadow-accent);
}
```

- [ ] **Step 3: Verify button feel**

Secondary buttons should be white with subtle border, press with bouncy scale-down + orange fill.

- [ ] **Step 4: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): side action buttons bounce + hover lift"
```

---

### Task 8: Update Record Button

**Files:**
- Modify: `src/public/style.css:537-598` (record-button and pulse)

- [ ] **Step 1: Update record button to gradient with glow**

Replace `.record-button` (lines 537-552):

```css
.record-button {
  width: clamp(62px, 8.5svh, 80px);
  height: clamp(62px, 8.5svh, 80px);
  display: grid;
  place-items: center;
  align-content: center;
  gap: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--accent-gradient);
  color: var(--accent-text);
  box-shadow: var(--shadow-accent-lg);
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  transition: transform 0.2s var(--ease-bounce), box-shadow 0.2s var(--ease-smooth);
}

.record-button:active:not(:disabled) {
  transform: scale(0.9);
  box-shadow: var(--shadow-accent);
}

.record-button:disabled {
  background: var(--text-muted);
  box-shadow: none;
  cursor: not-allowed;
}

.record-button.recording {
  background: var(--danger);
  box-shadow: 0 12px 28px rgba(239, 68, 68, 0.35);
}
```

- [ ] **Step 2: Update pulse animation shadow color**

Replace the `@keyframes pulse` (lines 594-598):

```css
@keyframes pulse {
  0%,
  100% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.34); }
  50% { box-shadow: 0 0 0 8px rgba(255, 255, 255, 0); }
}
```

(This remains the same — white pulse on red recording button is correct.)

- [ ] **Step 3: Verify record button**

Should be warm orange gradient with glow, bouncy press. Recording state stays red.

- [ ] **Step 4: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): record button gradient glow + bounce"
```

---

### Task 9: Update Tab Bar with Glassmorphism

**Files:**
- Modify: `src/public/style.css:656-687` (tab-bar, tab-btn)

- [ ] **Step 1: Update tab bar to glassmorphism**

Replace `.tab-bar` (lines 656-664):

```css
.tab-bar {
  display: flex;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  overflow: hidden;
  flex: 0 0 auto;
}
```

- [ ] **Step 2: Update tab button transitions and active state**

Replace `.tab-btn` and `.tab-btn.active` (lines 666-687):

```css
.tab-btn {
  flex: 1;
  min-height: clamp(36px, 5svh, 44px);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 clamp(10px, 2vw, 16px);
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: clamp(14px, 2svh, 17px);
  font-weight: 700;
  cursor: pointer;
  transition: background 0.25s var(--ease-smooth), color 0.25s var(--ease-smooth), box-shadow 0.25s var(--ease-smooth);
}

.tab-btn.active {
  background: var(--bg-card);
  color: var(--accent);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.06);
}
```

- [ ] **Step 3: Verify tab bar glass effect**

Tab bar should have a frosted glass look with blur. Active tab text should be warm orange.

- [ ] **Step 4: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): tab bar glassmorphism + active accent color"
```

---

### Task 10: Update Quick Commands & Terminal Buttons

**Files:**
- Modify: `src/public/style.css:706-744` (quick-btn), `606-640` (terminal-btn)

- [ ] **Step 1: Update quick button for refined style**

Replace `.quick-btn` (lines 715-733):

```css
.quick-btn {
  min-width: 0;
  min-height: clamp(30px, 4.2svh, 40px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 0 6px;
  border: 1.5px solid var(--border);
  border-radius: 999px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: clamp(12px, 1.7svh, 15px);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.2s var(--ease-bounce);
  box-shadow: var(--shadow-button);
}
```

- [ ] **Step 2: Update terminal button**

Replace `.terminal-btn` (lines 607-623):

```css
.terminal-btn {
  min-width: 0;
  min-height: clamp(28px, 4svh, 38px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: clamp(10px, 1.5svh, 14px);
  font-weight: 600;
  box-shadow: var(--shadow-button);
  cursor: pointer;
  transition: all 0.2s var(--ease-bounce);
}
```

- [ ] **Step 3: Update terminal icon color**

Replace `.terminal-icon` (lines 632-640):

```css
.terminal-icon {
  flex: 0 0 auto;
  padding: 1px 3px;
  border: 1px solid rgba(232, 121, 58, 0.3);
  border-radius: 4px;
  color: var(--accent);
  font-size: 10px;
  line-height: 1;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): quick/terminal buttons refined + bounce"
```

---

### Task 11: Update Phrases Panel, Dialog & Misc Components

**Files:**
- Modify: `src/public/style.css:754-976` (phrases, save-btn, toggle, dialog)

- [ ] **Step 1: Update phrases editing state**

Replace `.phrases-item.editing` (lines 820-823):

```css
.phrases-item.editing {
  background: var(--accent-soft);
  border-left: 3px solid var(--accent);
}
```

- [ ] **Step 2: Update phrases add/edit buttons**

Replace `.phrases-add-btn, .phrases-edit-done-btn` (lines 774-784):

```css
.phrases-add-btn,
.phrases-edit-done-btn {
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: clamp(13px, 1.9svh, 17px);
  font-weight: 750;
  cursor: pointer;
  padding: 0;
  white-space: nowrap;
  transition: opacity 0.2s var(--ease-smooth);
}
```

- [ ] **Step 3: Update save button**

Replace `.save-btn svg` color (lines 875-880):

```css
.save-btn svg {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  color: var(--accent);
}
```

Replace `.save-btn-sm` (lines 887-899):

```css
.save-btn-sm {
  min-height: 28px;
  padding: 0 10px;
  gap: 5px;
  font-size: 12px;
  border: 1px solid rgba(232, 121, 58, 0.2);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 650;
  cursor: pointer;
  box-shadow: none;
}
```

- [ ] **Step 4: Update toggle checked state**

Replace `.toggle-switch input:checked + .toggle-track` (lines 932-934):

```css
.toggle-switch input:checked + .toggle-track {
  background: var(--accent);
}
```

- [ ] **Step 5: Update add phrase dialog confirm button**

Replace `.add-phrase-confirm-btn` (lines 1051-1055):

```css
.add-phrase-confirm-btn {
  border: 0;
  background: var(--accent-gradient);
  color: var(--accent-text);
  box-shadow: var(--shadow-accent);
}
```

- [ ] **Step 6: Update add phrase overlay to warm tint**

Replace `.add-phrase-overlay` (lines 991-995):

```css
.add-phrase-overlay {
  position: fixed;
  inset: 0;
  background: rgba(200, 120, 50, 0.15);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
```

- [ ] **Step 7: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): phrases, dialog, toggle, save button warm orange"
```

---

### Task 12: Update Dark Mode

**Files:**
- Modify: `src/public/style.css:1110-1176` (`@media (prefers-color-scheme: dark)`)

- [ ] **Step 1: Replace dark mode variables**

Replace the dark mode `:root` block (lines 1111-1129):

```css
  :root {
    --bg-page: #181716;
    --bg-card: #272523;
    --bg-soft: #201e1c;
    --bg-chip: #2a2418;
    --text-primary: #f4f1ed;
    --text-secondary: #c1bdb7;
    --text-muted: #8c8781;
    --text-placeholder: #77716b;
    --border: rgba(255, 255, 255, 0.08);
    --border-strong: rgba(255, 255, 255, 0.12);
    --accent: #f97316;
    --accent-deep: #fdba74;
    --accent-soft: #2a1f14;
    --accent-softer: #231a12;
    --accent-gradient: linear-gradient(135deg, #f97316, #ea580c);
    --accent-glow: rgba(249, 115, 22, 0.3);
    --accent-text: #ffffff;
    --danger: #ef4444;
    --shadow-card: 0 12px 28px rgba(0, 0, 0, 0.28);
    --shadow-button: 0 4px 14px rgba(0, 0, 0, 0.22);
    --shadow-accent: 0 2px 10px rgba(249, 115, 22, 0.25);
    --shadow-accent-lg: 0 4px 16px rgba(249, 115, 22, 0.3);
    --shadow-button-hover: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
```

- [ ] **Step 2: Update dark mode specific overrides**

Replace the status-badge overrides (lines 1141-1157):

```css
  .status-badge {
    border-color: rgba(249, 115, 22, 0.2);
    background: var(--accent-soft);
    color: var(--accent-deep);
  }

  .status-badge.error {
    border-color: #7f1d1d;
    background: #2a1212;
    color: #fca5a5;
  }

  .status-badge.connecting {
    border-color: var(--border);
    background: var(--bg-soft);
    color: var(--text-secondary);
  }
```

- [ ] **Step 3: Update dark mode phrases editing**

Replace `.phrases-item.editing` dark override (lines 1164-1166):

```css
  .phrases-item.editing {
    background: var(--accent-soft);
  }
```

- [ ] **Step 4: Add dark mode gradient background**

Add after the dark mode body override section (before the closing `}`):

```css
  body {
    background: linear-gradient(165deg, #181716 0%, #1f1c18 40%, #1a1816 100%);
    background-attachment: fixed;
  }
```

- [ ] **Step 5: Add dark mode tab bar glass**

```css
  .tab-bar {
    background: rgba(39, 37, 35, 0.6);
  }

  .tab-btn.active {
    color: var(--accent);
  }
```

- [ ] **Step 6: Verify dark mode**

Toggle system dark mode. All elements should show warm tones against warm dark background.

- [ ] **Step 7: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): dark mode warm orange palette + gradient"
```

---

### Task 13: Update Responsive Breakpoints

**Files:**
- Modify: `src/public/style.css:1057-1108` (media query for small screens)

- [ ] **Step 1: Update small screen breakpoint for new shadows**

The small-screen breakpoint at lines 1057-1108 doesn't need structural changes since it references CSS variables. But verify that `--gap: 5px` override still works. No edit needed — just verify visually at narrow widths.

- [ ] **Step 2: Test at 395px and 760px breakpoints**

Open browser DevTools, test at 375px width and 700px height. Ensure:
- Buttons don't overflow
- Gradients and shadows remain visible
- Glass tab bar renders correctly

- [ ] **Step 3: Final visual QA**

Test both light and dark mode. Check:
- [ ] Header brand mark gradient visible
- [ ] Device pill warm tint
- [ ] Input card focus shadow lift
- [ ] Button bounce on press
- [ ] Record button gradient and glow
- [ ] Tab bar glass blur effect
- [ ] Quick commands refined shadow
- [ ] Dialog overlay warm tint
- [ ] Dark mode gradient background

- [ ] **Step 4: Commit**

```bash
git add src/public/style.css
git commit -m "style(dopamine): final responsive QA"
```
