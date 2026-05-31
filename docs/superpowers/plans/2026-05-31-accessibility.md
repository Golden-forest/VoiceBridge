# Accessibility (L7) 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 VoiceBridge 所有纯 HTML/CSS 层面的无障碍问题，以及极少量 JS 端 ARIA 属性赋值（方案 B — 低成本修复）。

**Architecture:** 三个文件各改一处：CSS 负责焦点指示器、颜色对比度、reduced-motion；HTML 负责语义标签和静态 ARIA 属性；JS 负责动态 ARIA 属性赋值（不涉及新的事件处理逻辑）。

**Tech Stack:** HTML5, CSS3, Vanilla JS, ARIA 1.1

**Design Spec:** `docs/superpowers/specs/2026-05-31-accessibility-design.md`

---

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `src/public/style.css` | 焦点指示器、颜色对比度、reduced-motion、h1/fieldset 样式重置 | Modify |
| `src/public/index.html` | 语义标签升级、静态 ARIA 属性、表单 label 关联 | Modify |
| `src/public/app.js` | 动态 ARIA 属性赋值（aria-expanded、aria-selected、role="tab"） | Modify |

---

### Task 1: CSS 修复（焦点指示器 + 对比度 + reduced-motion + 语义标签样式）

**Files:**
- Modify: `src/public/style.css`

- [ ] **Step 1: 修复颜色对比度 — 亮色模式变量**

修改 `:root` 中的两个颜色变量（第 9-10 行）：

```css
/* Before (line 9-10) */
  --text-muted: #a8a29e;
  --text-placeholder: #c7bfb8;

/* After */
  --text-muted: #7c756f;
  --text-placeholder: #8a827c;
```

- [ ] **Step 2: 修复颜色对比度 — 暗色模式变量**

修改 `@media (prefers-color-scheme: dark)` 中的两个颜色变量（第 1328-1329 行）：

```css
/* Before (line 1328-1329) */
    --text-muted: #8c8781;
    --text-placeholder: #77716b;

/* After */
    --text-muted: #a09a94;
    --text-placeholder: #8a827c;
```

暗色模式背景 `--bg-page: #181716`，需确保文本在深色背景上达到 4.5:1 对比度。

- [ ] **Step 3: 移除 outline: none — .text-input**

修改第 469 行，删除 `outline: none;`：

```css
/* Before (line 468-470) */
  resize: none;
  outline: none;
  overflow-y: auto;

/* After */
  resize: none;
  overflow-y: auto;
```

- [ ] **Step 4: 移除 outline: none — .cmd-search-input**

修改第 863 行，删除 `outline: none;`：

```css
/* Before (line 862-864) */
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s var(--ease-smooth);

/* After */
  font-size: 14px;
  transition: border-color 0.2s var(--ease-smooth);
```

- [ ] **Step 5: 强化 .cmd-search-input:focus 规则**

修改第 872-873 行的 focus 规则，增加 border-width 以提高对比度，同时覆盖 outline：

```css
/* Before (line 872-874) */
.cmd-search-input:focus {
  border-color: var(--accent);
}

/* After */
.cmd-search-input:focus {
  border-color: var(--accent);
  border-width: 2px;
  outline: none;
}
```

- [ ] **Step 6: 移除 outline: none — .cmd-edit-label**

修改第 972-973 行，删除 `outline: none; outline-offset: -1px;`：

```css
/* Before (line 971-974) */
  font-size: 14px;
  outline: none;
  outline-offset: -1px;
  padding: 8px 12px;

/* After */
  font-size: 14px;
  padding: 8px 12px;
```

- [ ] **Step 7: 添加 h1 样式重置和 fieldset 样式**

在 `.brand` 规则（第 126-132 行）后面添加 h1 重置和 fieldset/legend 样式。在 `.brand { ... }` 的闭合 `}` 之后、`.refresh-button` 之前插入：

```css
h1.brand {
  margin: 0;
}

fieldset.add-cmd-fieldset {
  border: none;
  padding: 0;
  margin: 0;
}

fieldset.add-cmd-fieldset legend {
  font-size: 18px;
  font-weight: 750;
  color: var(--text-primary);
  margin-bottom: 14px;
  padding: 0;
}
```

注意：原 `.add-cmd-title` 规则（第 1052-1057 行）将被 HTML 中的 `<legend>` 替代，样式由上面的 `legend` 规则覆盖。原 `.add-cmd-title` CSS 规则可以保留不删除（因为 class 已不存在于 HTML 中，不会生效）。

- [ ] **Step 8: 添加全局 :focus-visible 规则**

在 CSS 文件末尾（第 1407 行之后）添加：

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

- [ ] **Step 9: 添加 prefers-reduced-motion 规则**

紧跟 `:focus-visible` 规则之后添加：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 10: 浏览器验证 CSS 修复**

1. 启动服务器，在浏览器中打开页面
2. Tab 到 text-input、cmd-search-input — 确认出现橙色 focus-visible 轮廓
3. 检查 placeholder 文字颜色是否比之前更深
4. 打开 DevTools → Rendering → Emulate CSS media feature `prefers-reduced-motion: reduce` — 确认所有动画/过渡消失
5. 切换暗色模式 — 确认 muted/placeholder 文字可读性

- [ ] **Step 11: Commit CSS 修复**

```bash
git add src/public/style.css
git commit -m "fix(a11y): focus indicators, contrast ratios, reduced-motion support"
```

---

### Task 2: HTML 语义修复（标签升级 + ARIA 属性 + 表单 label）

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: span.brand → h1.brand**

修改第 21 行：

```html
<!-- Before -->
          <span class="brand">VoiceBridge</span>

<!-- After -->
          <h1 class="brand">VoiceBridge</h1>
```

- [ ] **Step 2: 添加 aria-hidden 到装饰性 SVG**

修改第 24 行和第 55 行的 SVG 标签：

```html
<!-- Before (line 24) -->
            <svg viewBox="0 0 24 24">

<!-- After -->
            <svg viewBox="0 0 24 24" aria-hidden="true">
```

```html
<!-- Before (line 55) -->
            <svg viewBox="0 0 24 24" width="18" height="18">

<!-- After -->
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
```

- [ ] **Step 3: #statusDot 添加 aria-label**

修改第 41 行：

```html
<!-- Before -->
          <button id="statusDot" class="status-dot connecting" type="button" title="正在连接"></button>

<!-- After -->
          <button id="statusDot" class="status-dot connecting" type="button" title="正在连接" aria-label="连接状态"></button>
```

- [ ] **Step 4: #windowBtn 添加 aria-haspopup 和 aria-expanded**

修改第 43 行：

```html
<!-- Before -->
            <button id="windowBtn" class="window-btn" type="button">

<!-- After -->
            <button id="windowBtn" class="window-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
```

- [ ] **Step 5: #windowDropdown 添加 role="listbox"**

修改第 47 行：

```html
<!-- Before -->
            <div id="windowDropdown" class="window-dropdown hidden">

<!-- After -->
            <div id="windowDropdown" class="window-dropdown hidden" role="listbox">
```

- [ ] **Step 6: #textInput 添加 aria-label**

修改第 66 行：

```html
<!-- Before -->
          <textarea id="textInput" class="text-input" placeholder="输入文字，或语音识别…" enterkeyhint="send" rows="3" maxlength="2000"></textarea>

<!-- After -->
          <textarea id="textInput" class="text-input" placeholder="输入文字，或语音识别…" enterkeyhint="send" rows="3" maxlength="2000" aria-label="文字输入"></textarea>
```

- [ ] **Step 7: .library-panel 添加 role 和 aria-label**

修改第 138 行：

```html
<!-- Before -->
        <div class="library-panel">

<!-- After -->
        <div class="library-panel" role="region" aria-label="指令库">
```

- [ ] **Step 8: #tabScroll 添加 role="tablist"**

修改第 140 行：

```html
<!-- Before -->
            <div class="tab-scroll" id="tabScroll"></div>

<!-- After -->
            <div class="tab-scroll" id="tabScroll" role="tablist"></div>
```

- [ ] **Step 9: #cmdSearchInput 添加 aria-label**

修改第 143 行：

```html
<!-- Before -->
            <input id="cmdSearchInput" class="cmd-search-input" type="text" placeholder="搜索指令…" />

<!-- After -->
            <input id="cmdSearchInput" class="cmd-search-input" type="text" placeholder="搜索指令…" aria-label="搜索指令" />
```

- [ ] **Step 10: #commandLibrary 添加 role="tabpanel"**

修改第 145 行：

```html
<!-- Before -->
          <div id="commandLibrary" class="command-library"></div>

<!-- After -->
          <div id="commandLibrary" class="command-library" role="tabpanel"></div>
```

- [ ] **Step 11: 弹窗表单 — fieldset + legend + label 替换**

修改第 160-164 行，将弹窗表单内容包裹在 fieldset 中：

```html
<!-- Before (line 158-165) -->
      <div class="add-cmd-sheet">
        <div class="add-cmd-handle"></div>
        <div class="add-cmd-title">新增指令</div>
        <div class="add-cmd-label">指令内容</div>
        <textarea id="addCommandInput" class="add-cmd-textarea" rows="3" placeholder="输入指令内容…"></textarea>
        <div class="add-cmd-label">分类</div>
        <select id="addCommandCategory" class="add-cmd-select"></select>

<!-- After -->
      <div class="add-cmd-sheet">
        <div class="add-cmd-handle"></div>
        <fieldset class="add-cmd-fieldset">
          <legend>新增指令</legend>
          <label for="addCommandInput" class="add-cmd-label">指令内容</label>
          <textarea id="addCommandInput" class="add-cmd-textarea" rows="3" placeholder="输入指令内容…"></textarea>
          <label for="addCommandCategory" class="add-cmd-label">分类</label>
          <select id="addCommandCategory" class="add-cmd-select"></select>
```

同时在弹窗底部 `</div>` (`.add-cmd-actions` 的闭合) 之后、`</div>` (`.add-cmd-sheet` 的闭合) 之前添加 `</fieldset>`。当前结构是：

```html
<!-- Before (line 166-170) -->
          <div class="add-cmd-actions">
            <button id="addCmdCancelBtn" class="add-cmd-cancel" type="button">取消</button>
            <button id="addCmdConfirmBtn" class="add-cmd-confirm" type="button">保存</button>
          </div>
      </div>

<!-- After -->
          <div class="add-cmd-actions">
            <button id="addCmdCancelBtn" class="add-cmd-cancel" type="button">取消</button>
            <button id="addCmdConfirmBtn" class="add-cmd-confirm" type="button">保存</button>
          </div>
        </fieldset>
      </div>
```

注意：`<div class="add-cmd-new-cat ...">` (line 165) 在 fieldset 内部，保持不变。

- [ ] **Step 12: 浏览器验证 HTML 修复**

1. 打开页面，用 Accessibility Inspector（Safari）或 Accessibility Tree（Chrome DevTools）检查：
   - h1.brand 存在且内容为 "VoiceBridge"
   - #textInput 有 aria-label "文字输入"
   - #cmdSearchInput 有 aria-label "搜索指令"
   - .library-panel 有 role="region" aria-label="指令库"
   - #tabScroll 有 role="tablist"
   - #commandLibrary 有 role="tabpanel"
   - #windowBtn 有 aria-haspopup="listbox"
   - #windowDropdown 有 role="listbox"
   - #statusDot 有 aria-label="连接状态"
   - 两个 SVG 有 aria-hidden="true"
2. 打开新增指令弹窗，检查：
   - fieldset 包裹表单内容
   - legend 文本为 "新增指令"
   - 两个 label 正确关联（for 属性匹配 id）
3. 整体布局无视觉变化

- [ ] **Step 13: Commit HTML 修复**

```bash
git add src/public/index.html
git commit -m "fix(a11y): semantic HTML, ARIA roles, form labels"
```

---

### Task 3: JS 端 ARIA 属性动态赋值

**Files:**
- Modify: `src/public/app.js`

- [ ] **Step 1: WindowSelector._toggle 添加 aria-expanded**

修改 `_toggle`、`_open`、`_close` 三个方法（第 192-194 行），在 `_open` 和 `_close` 中更新 `aria-expanded`：

```javascript
// Before (line 192-194)
  _toggle() { this._isOpen ? this._close() : this._open(); }
  _open() { this._isOpen = true; this.el.dropdown.classList.remove("hidden"); this._fetchWindows(); }
  _close() { this._isOpen = false; this.el.dropdown.classList.add("hidden"); }

// After
  _toggle() { this._isOpen ? this._close() : this._open(); }
  _open() { this._isOpen = true; this.el.dropdown.classList.remove("hidden"); this.el.btn.setAttribute("aria-expanded", "true"); this._fetchWindows(); }
  _close() { this._isOpen = false; this.el.dropdown.classList.add("hidden"); this.el.btn.setAttribute("aria-expanded", "false"); }
```

- [ ] **Step 2: WindowSelector._renderWindows 添加 aria-selected**

在创建 window-item 按钮后（第 247 行之后），为选中项设置 `aria-selected`。修改第 246-248 行：

```javascript
// Before (line 246-248)
        const isSelected = this.selectedWindow && this.selectedWindow.appName === group.appName && this.selectedWindow.windowTitle === win.title;
        if (isSelected) btn.classList.add("selected");

// After
        const isSelected = this.selectedWindow && this.selectedWindow.appName === group.appName && this.selectedWindow.windowTitle === win.title;
        if (isSelected) btn.classList.add("selected");
        btn.setAttribute("aria-selected", String(isSelected));
```

- [ ] **Step 3: CommandLibrary.renderTabs 添加 role="tab" 和 aria-selected**

在 renderTabs 方法中，为每个 tab 按钮添加 ARIA 属性。修改两处按钮创建代码：

**"最近" tab 按钮（第 393-404 行）：**

在 `recentBtn.type = "button";` (line 395) 之后添加两行：

```javascript
// Before (line 394-396)
      recentBtn.className = "tab-item" + (this.activeCategory === "最近" ? " active" : "");
      recentBtn.type = "button";
      recentBtn.dataset.category = "最近";

// After
      recentBtn.className = "tab-item" + (this.activeCategory === "最近" ? " active" : "");
      recentBtn.type = "button";
      recentBtn.setAttribute("role", "tab");
      recentBtn.setAttribute("aria-selected", String(this.activeCategory === "最近"));
      recentBtn.dataset.category = "最近";
```

**普通分类 tab 按钮（第 407-410 行）：**

在 `btn.type = "button";` (line 409) 之后添加两行：

```javascript
// Before (line 408-410)
      btn.className = "tab-item" + (category === this.activeCategory ? " active" : "");
      btn.type = "button";
      btn.dataset.category = category;

// After
      btn.className = "tab-item" + (category === this.activeCategory ? " active" : "");
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(category === this.activeCategory));
      btn.dataset.category = category;
```

- [ ] **Step 4: 浏览器验证 JS 动态 ARIA**

1. 打开页面，用 DevTools Elements 面板：
   - 点击窗口选择按钮 → `aria-expanded` 变为 `"true"`，再点击 → 变为 `"false"`
   - 打开窗口下拉列表 → 每个 `.window-item` 按钮应有 `aria-selected="true"` 或 `"false"`
   - 点击不同的 tab → 对应 tab 的 `aria-selected` 为 `"true"`，其他为 `"false"`
   - 所有 tab 按钮均有 `role="tab"`
2. 用 Accessibility Tree 确认属性正确传递

- [ ] **Step 5: Commit JS 修复**

```bash
git add src/public/app.js
git commit -m "fix(a11y): dynamic ARIA attributes for tabs, windows, dropdown"
```

---

### Task 4: 更新项目计划 + 最终验证

**Files:**
- Modify: `docs/superpowers/plans/2026-05-31-audit-fixes.md`

- [ ] **Step 1: 更新审计计划文档**

在 `docs/superpowers/plans/2026-05-31-audit-fixes.md` 的「剩余」部分，将 L7 标记为已完成：

```markdown
/* Before */
- [ ] **L7** 无障碍访问缺失 (需全面UI审查)

/* After */
- [x] **L7** 无障碍访问修复 — 方案B: CSS焦点/对比度/reduced-motion + HTML语义/ARIA + JS动态属性 (style.css, index.html, app.js)
```

- [ ] **Step 2: 最终全面验证**

1. 在亮色模式下打开页面，逐一检查所有修改点
2. 在暗色模式下打开页面，确认 muted/placeholder 文字可读
3. 用 Lighthouse Accessibility 审计，记录分数
4. 确认无 JS 控制台错误

- [ ] **Step 3: Final Commit**

```bash
git add docs/superpowers/plans/2026-05-31-audit-fixes.md
git commit -m "docs: mark L7 accessibility as completed in audit plan"
```
