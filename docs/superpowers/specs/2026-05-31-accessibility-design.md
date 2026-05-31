# VoiceBridge 无障碍访问 (Accessibility) 设计

日期: 2026-05-31
方案: 方案 B — 低成本修复（HTML/CSS + 少量 ARIA 属性赋值）

## 背景

VoiceBridge 的主要交互方式是手机触摸操作。全面 WCAG AA 合规（键盘导航、focus trap）投入产出比不高，因此选择方案 B：修复所有纯 HTML/CSS 层面的无障碍问题，以及极少量 JS 端 ARIA 属性赋值（不涉及新的键盘事件处理逻辑）。

## 修改文件

- `src/public/style.css` — 焦点指示器、对比度、reduced-motion
- `src/public/index.html` — 语义标签、ARIA 属性、heading 层级
- `src/public/app.js` — 极少量 ARIA 属性动态赋值（aria-expanded、aria-selected）

## 1. CSS 修复

### 1.1 焦点指示器

移除以下元素的 `outline: none`：
- `.text-input` (style.css ~L469)
- `.cmd-search-input` (style.css ~L863)
- `.cmd-edit-label` (style.css ~L972)

新增全局 `:focus-visible` 规则：
```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

对已有自定义 focus 样式的元素（如 `.cmd-search-input:focus` 的 border-color 变化），补充 border-width 加粗以保持足够对比度，并覆盖 `outline: none`。

### 1.2 颜色对比度

| CSS 变量 | 当前值 | 白底对比度 | 修复值 | 修复后对比度 |
|----------|--------|-----------|--------|-------------|
| `--text-placeholder` | `#c7bfb8` | ~2.7:1 | `#8a827c` | ~4.6:1 |
| `--text-muted` | `#a8a29e` | ~3.1:1 | `#7c756f` | ~4.6:1 |

暗色模式同步调整对应变量，确保暗色背景上对比度也达到 4.5:1。

### 1.3 prefers-reduced-motion

在 CSS 末尾新增：
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

影响范围：`blink` 动画（状态点）、`pulse` 动画（录音按钮）、所有 hover/active transitions。

## 2. HTML 语义修复

### 2.1 标题层级

- `<span class="brand">VoiceBridge</span>` → `<h1 class="brand">VoiceBridge</h1>`
- 弹窗标题 `<div class="add-cmd-title">新增指令</div>` → 由 `<fieldset><legend>` 替代（见 2.3）
- `h1` 样式重置：与原 span 一致（font-size、font-weight、margin: 0）

### 2.2 表单标签

- `#textInput` 添加 `aria-label="文字输入"`
- `#cmdSearchInput` 添加 `aria-label="搜索指令"`
- 弹窗内 `<div class="add-cmd-label">分类</div>` → `<label for="addCommandCategory">分类</label>`

### 2.3 弹窗表单结构

弹窗表单用 `<fieldset>` + `<legend>新增指令</legend>` 包裹，同时替代 2.1 中的 h2。

### 2.4 ARIA 角色/属性

| 元素 | 添加 |
|------|------|
| `#statusDot` button | `aria-label="连接状态"` |
| `#windowBtn` button | `aria-haspopup="listbox" aria-expanded="false"` |
| `#windowDropdown` div | `role="listbox"` |
| `.library-panel` div | `role="region" aria-label="指令库"` |
| `.tab-scroll` div | `role="tablist"` |
| `.tab-item` buttons (JS 生成) | `role="tab" aria-selected="true/false"` |
| `.library-content` div | `role="tabpanel"` |
| 刷新按钮 SVG | `aria-hidden="true"` |
| 搜索按钮 SVG | `aria-hidden="true"` |

### 2.5 窗口列表项

`.window-item` button 添加 `aria-selected="true/false"`（选中项为 true）。

## 3. JS 端改动（极少量）

仅涉及 ARIA 属性赋值，不涉及新的事件处理逻辑：

- `WindowSelector._toggle()`: 切换 `aria-expanded` on `#windowBtn`
- `WindowSelector._renderWindows()`: 为 `.window-item` 设置 `aria-selected`
- `CommandLibrary.renderTabs()`: 为 `.tab-item` 设置 `role="tab"` 和 `aria-selected`

## 4. 不在范围内（方案 C 才涉及）

以下问题因需要新增键盘事件处理逻辑，不在本次修复范围：
- 弹窗 focus trap 和 Escape 关闭
- 窗口下拉菜单 ArrowUp/Down 键盘导航
- Tab 切换 ArrowLeft/Right 键盘导航
- 编辑模式的键盘替代方案
- 删除/完成按钮从 `<span>` 改为 `<button>`
- 动态 DOM 重建时的焦点保持
