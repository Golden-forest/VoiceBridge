# 统一指令库 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将"更多指令"和"常用语"合并为一个统一的指令库面板，通过服务端 API 持久化，支持分类管理、增删编辑、搜索和跨设备同步。

**Architecture:** 服务端新增 `/api/commands` CRUD 路由，读写 `commands.json` 文件（含旧格式自动迁移）。前端用 `CommandLibrary` 类替代 `PhrasesManager` 和 `loadCommands()`，通过 API 读写指令数据。UI 去掉双 Tab，替换为统一的分类折叠面板。

**Tech Stack:** Express.js（路由）, Node.js `crypto.randomUUID()`, Vanilla JS（前端）, CSS（暗色暖橙主题）

---

### Task 1: 新建 commands.json 新格式种子文件 + 旧格式迁移逻辑

**Files:**
- Create: `src/server/routes/commands.js`
- Modify: `src/server/index.js:36-55`

- [ ] **Step 1: 创建 commands 路由文件，包含旧格式迁移和 CRUD**

创建 `src/server/routes/commands.js`：

```javascript
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_PATH = join(__dirname, "../../public/commands.json");

/** 读取 commands.json，如果不存在或损坏返回 null */
async function readCommandsFile() {
  try {
    const raw = await readFile(COMMANDS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 写入 commands.json */
async function writeCommandsFile(data) {
  await writeFile(COMMANDS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** 检测旧格式并迁移为新格式 */
function migrateOldFormat(data) {
  if (data && data.commands && Array.isArray(data.commands)) {
    // 已经是新格式
    return data;
  }

  const now = Date.now();
  const commands = [];

  // 旧格式: { terminal: [...], shortcuts: [...], quick: [...] }
  if (data) {
    // shortcuts -> 斜杠指令
    if (Array.isArray(data.shortcuts)) {
      for (const cmd of data.shortcuts) {
        commands.push({
          id: randomUUID(),
          text: cmd.text,
          label: cmd.label,
          category: "斜杠指令",
          createdAt: now,
          lastUsedAt: now,
        });
      }
    }
    // terminal -> 终端
    if (Array.isArray(data.terminal)) {
      for (const cmd of data.terminal) {
        commands.push({
          id: randomUUID(),
          text: cmd.text,
          label: cmd.label,
          category: "终端",
          createdAt: now,
          lastUsedAt: now,
        });
      }
    }
    // quick -> 智能归类
    if (Array.isArray(data.quick)) {
      for (const cmd of data.quick) {
        let category = "通用";
        const t = cmd.text;
        if (t.startsWith("/")) category = "斜杠指令";
        else if (/npm|node|copyclaw|server|cli/.test(t)) category = "终端";
        else if (/审查|巡检|实测|分析|复查|修复|bug/.test(t)) category = "工作流";
        else if (/确认|计划|目标|最优|关联|问清|代码|需求/.test(t)) category = "开发协作";
        commands.push({
          id: randomUUID(),
          text: cmd.text,
          label: cmd.label,
          category,
          createdAt: now,
          lastUsedAt: now,
        });
      }
    }
  }

  // 如果没有任何旧数据，写入空的种子
  if (commands.length === 0) {
    return { commands: [] };
  }

  return { commands };
}

/** 确保 commands.json 是新格式，首次访问时自动迁移 */
export async function ensureCommandsFile() {
  const data = await readCommandsFile();
  const migrated = migrateOldFormat(data);
  await writeCommandsFile(migrated);
  return migrated;
}

export function createCommandsRouter() {
  const router = express.Router();

  // GET /api/commands — 返回全部指令
  router.get("/commands", async (_req, res) => {
    try {
      const data = await ensureCommandsFile();
      res.json(data.commands);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/commands — 新增一条指令
  router.post("/commands", async (req, res) => {
    try {
      const { text, label, category } = req.body;
      if (!text || !label || !category) {
        res.status(400).json({ error: "缺少 text, label 或 category 字段" });
        return;
      }
      const now = Date.now();
      const cmd = {
        id: randomUUID(),
        text,
        label,
        category,
        createdAt: now,
        lastUsedAt: now,
      };
      const data = await ensureCommandsFile();
      data.commands.push(cmd);
      await writeCommandsFile(data);
      res.status(201).json(cmd);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/commands/:id — 更新一条指令
  router.put("/commands/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body; // { text?, label?, category?, lastUsedAt? }
      const data = await ensureCommandsFile();
      const idx = data.commands.findIndex((c) => c.id === id);
      if (idx === -1) {
        res.status(404).json({ error: "指令不存在" });
        return;
      }
      data.commands[idx] = { ...data.commands[idx], ...updates, id }; // id 不可修改
      await writeCommandsFile(data);
      res.json(data.commands[idx]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/commands/:id — 删除一条指令
  router.delete("/commands/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const data = await ensureCommandsFile();
      const idx = data.commands.findIndex((c) => c.id === id);
      if (idx === -1) {
        res.status(404).json({ error: "指令不存在" });
        return;
      }
      data.commands.splice(idx, 1);
      await writeCommandsFile(data);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
```

注意：文件顶部需要引入 express。在 Step 3 修改 index.js 时确认引入方式。

- [ ] **Step 2: 在 server/index.js 中注册 commands 路由**

在 `src/server/index.js` 中：

在文件顶部的 import 区域（大约第 3-6 行）添加：

```javascript
import { createCommandsRouter } from "./routes/commands.js";
```

在 `app.use("/api", createUploadRouter({ config, wsHub, tmpDir }));` 这一行（第 55 行）之后添加：

```javascript
app.use("/api", createCommandsRouter());
```

- [ ] **Step 3: 添加 express 引入到 commands.js**

如果 `commands.js` 中的 `express.Router()` 报错，需要在文件顶部添加 express 引入。查看 `src/server/index.js` 的 import 方式：

根据项目使用的 ES module 风格，在 `src/server/routes/commands.js` 顶部添加：

```javascript
import express from "express";
```

- [ ] **Step 4: 手动验证 API**

启动服务后用 curl 测试：

```bash
# 测试 GET（会触发旧格式迁移）
curl http://localhost:3000/api/commands | head -c 200

# 检查 commands.json 是否已迁移为新格式
cat src/public/commands.json | head -c 200
```

预期：GET 返回一个 JSON 数组，commands.json 已变为 `{ "commands": [...] }` 格式。

- [ ] **Step 5: 提交**

```bash
git add src/server/routes/commands.js src/server/index.js
git commit -m "feat(commands-api): add CRUD /api/commands with old format migration"
```

---

### Task 2: 前端 — 新建 CommandLibrary 类

**Files:**
- Modify: `src/public/app.js`

- [ ] **Step 1: 用 CommandLibrary 替换 loadCommands 函数**

在 `src/public/app.js` 中，删除 `loadCommands()` 函数（第 551-611 行）以及末尾的 `loadCommands()` 调用（约第 613 行），替换为 `CommandLibrary` 类。

**先备份需要的信息：** 当前 `loadCommands()` 渲染的 `#quickBtns` 容器在 HTML 中位于 `<div id="quickPanel" class="tab-panel">` 内。CommandLibrary 将接管这个容器的渲染。

在原来 `loadCommands()` 函数所在位置插入：

```javascript
// === Command Library (统一指令库) ===
class CommandLibrary {
  constructor(containerEl) {
    this.container = containerEl;
    this.commands = [];
    this.editingId = null;
    this.searchVisible = false;
    this.collapsedCategories = new Set();
    this._bindContainerEvents();
    this.load();
  }

  _bindContainerEvents() {
    // 委托事件：指令按钮点击、分类标题点击
    this.container.addEventListener("click", (e) => {
      const cmdBtn = e.target.closest(".cmd-btn");
      if (cmdBtn && !this.editingId) {
        const text = cmdBtn.dataset.text;
        const label = cmdBtn.dataset.label || cmdBtn.textContent.trim();
        if (text) {
          sendQuickCommand(text, label);
          this.touchCommand(cmdBtn.dataset.id);
        }
        return;
      }
      const catHeader = e.target.closest(".category-header");
      if (catHeader) {
        const cat = catHeader.dataset.category;
        this.toggleCategory(cat);
      }
    });
  }

  async load() {
    try {
      const res = await fetch("/api/commands");
      this.commands = await res.json();
      this.render();
    } catch {
      // 静默失败
    }
  }

  _getCategories() {
    const catMap = new Map();
    for (const cmd of this.commands) {
      if (!catMap.has(cmd.category)) {
        catMap.set(cmd.category, []);
      }
      catMap.get(cmd.category).push(cmd);
    }
    // 分类内按 lastUsedAt 降序
    for (const [, cmds] of catMap) {
      cmds.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    }
    // 分类间按该分类最大 lastUsedAt 降序
    const sorted = [...catMap.entries()].sort((a, b) => {
      const maxA = Math.max(...a[1].map((c) => c.lastUsedAt || 0));
      const maxB = Math.max(...b[1].map((c) => c.lastUsedAt || 0));
      return maxB - maxA;
    });
    return sorted;
  }

  _getUniqueCategories() {
    return [...new Set(this.commands.map((c) => c.category))];
  }

  render(filter = "") {
    const lowerFilter = filter.toLowerCase();
    const container = this.container;

    container.innerHTML = "";

    // 按分类渲染
    const categories = this._getCategories();

    for (const [category, cmds] of categories) {
      const filteredCmds = lowerFilter
        ? cmds.filter((c) => c.text.toLowerCase().includes(lowerFilter) || c.label.toLowerCase().includes(lowerFilter))
        : cmds;

      if (lowerFilter && filteredCmds.length === 0) continue;

      // 分类标题
      const header = document.createElement("div");
      header.className = "category-header";
      header.dataset.category = category;
      const isCollapsed = this.collapsedCategories.has(category) && !lowerFilter;
      header.innerHTML = `
        <div class="category-left">
          <span class="category-arrow${isCollapsed ? " collapsed" : ""}">▾</span>
          <span class="category-name">${category}</span>
        </div>
        <span class="category-count">${filteredCmds.length}</span>
      `;
      container.appendChild(header);

      // 指令网格
      const grid = document.createElement("div");
      grid.className = "cmd-grid";
      if (isCollapsed) grid.classList.add("collapsed");

      for (const cmd of filteredCmds) {
        const btn = document.createElement("button");
        btn.className = "cmd-btn";
        btn.type = "button";
        btn.dataset.id = cmd.id;
        btn.dataset.text = cmd.text;
        btn.dataset.label = cmd.label;
        btn.textContent = cmd.label;
        btn.title = cmd.text;

        // 斜杠/终端指令用 monospace 样式
        if (cmd.text.startsWith("/") || /^(npm|node|copyclaw|npx)\b/.test(cmd.text)) {
          btn.classList.add("slash");
        }

        // 长按进入编辑模式
        let longPressTimer = null;
        btn.addEventListener("pointerdown", () => {
          longPressTimer = setTimeout(() => {
            this._enterEditMode(cmd.id);
            longPressTimer = null;
          }, 500);
        });
        btn.addEventListener("pointerup", () => { if (longPressTimer) clearTimeout(longPressTimer); });
        btn.addEventListener("pointerleave", () => { if (longPressTimer) clearTimeout(longPressTimer); });

        // 编辑模式状态
        if (this.editingId === cmd.id) {
          btn.classList.add("editing");
          btn.contentEditable = "true";
          btn.dataset.originalLabel = cmd.label;
          btn.dataset.originalText = cmd.text;
          btn.focus();
        } else if (this.editingId) {
          btn.classList.add("dimmed");
        }

        grid.appendChild(btn);
      }
      container.appendChild(grid);

      // 编辑模式操作栏
      if (this.editingId && !lowerFilter) {
        const editingCmd = this.commands.find((c) => c.id === this.editingId);
        if (editingCmd && editingCmd.category === category) {
          const actions = document.createElement("div");
          actions.className = "cmd-edit-actions";
          actions.innerHTML = `
            <button class="cmd-delete-btn" type="button">删除此指令</button>
            <button class="cmd-done-btn" type="button">完成</button>
          `;
          actions.querySelector(".cmd-delete-btn").addEventListener("click", () => {
            this._deleteCommand(this.editingId);
          });
          actions.querySelector(".cmd-done-btn").addEventListener("click", () => {
            this._exitEditMode();
          });
          container.appendChild(actions);
        }
      }
    }
  }

  toggleCategory(category) {
    if (this.collapsedCategories.has(category)) {
      this.collapsedCategories.delete(category);
    } else {
      this.collapsedCategories.add(category);
    }
    this.render();
  }

  _enterEditMode(id) {
    this.editingId = id;
    this.render();
  }

  _exitEditMode() {
    if (!this.editingId) return;
    const btn = this.container.querySelector(`.cmd-btn[data-id="${this.editingId}"]`);
    if (btn) {
      const newLabel = btn.textContent.trim();
      const originalText = btn.dataset.originalText;
      const originalLabel = btn.dataset.originalLabel;
      if (newLabel !== originalLabel || newLabel === "") {
        if (newLabel === "") {
          // 空内容视为删除
          this._deleteCommand(this.editingId);
          return;
        }
        // label 变了，更新（text 保持不变）
        this._updateCommand(this.editingId, { label: newLabel });
      }
    }
    this.editingId = null;
    this.render();
  }

  _deleteCommand(id) {
    fetch(`/api/commands/${id}`, { method: "DELETE" })
      .then(() => {
        this.commands = this.commands.filter((c) => c.id !== id);
        this.editingId = null;
        this.render();
      })
      .catch(() => {});
  }

  _updateCommand(id, updates) {
    fetch(`/api/commands/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    })
      .then((res) => res.json())
      .then((updated) => {
        const idx = this.commands.findIndex((c) => c.id === id);
        if (idx !== -1) this.commands[idx] = updated;
        this.editingId = null;
        this.render();
      })
      .catch(() => {});
  }

  async touchCommand(id) {
    const now = Date.now();
    try {
      const res = await fetch(`/api/commands/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastUsedAt: now }),
      });
      const updated = await res.json();
      const idx = this.commands.findIndex((c) => c.id === id);
      if (idx !== -1) this.commands[idx] = updated;
      this.render();
    } catch {
      // 静默失败，不影响发送
    }
  }

  async addCommand(text, category) {
    const label = text.length > 8 ? text.slice(0, 8) + "…" : text;
    try {
      const res = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, label, category }),
      });
      const cmd = await res.json();
      this.commands.push(cmd);
      this.render();
      return cmd;
    } catch {
      return null;
    }
  }

  getUniqueCategories() {
    return this._getUniqueCategories();
  }

  /** 打开新增/收藏弹窗，preText 为预填文本（可空） */
  openAddDialog(preText = "") {
    const dialog = document.getElementById("addCommandDialog");
    const input = document.getElementById("addCommandInput");
    const select = document.getElementById("addCommandCategory");
    const newCatInput = document.getElementById("addCommandNewCategory");

    // 填充分类下拉
    select.innerHTML = "";
    const categories = this._getUniqueCategories();
    categories.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      select.appendChild(opt);
    });
    const newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "+ 新建分类…";
    newOpt.style.color = "var(--accent, #ff8c42)";
    select.appendChild(newOpt);

    // 预填文本
    input.value = preText;
    newCatInput.value = "";
    newCatInput.classList.remove("show");

    dialog.classList.remove("hidden");
    input.focus();
  }

  closeAddDialog() {
    document.getElementById("addCommandDialog").classList.add("hidden");
  }

  async confirmAdd() {
    const input = document.getElementById("addCommandInput");
    const select = document.getElementById("addCommandCategory");
    const newCatInput = document.getElementById("addCommandNewCategory");
    const text = input.value.trim();
    if (!text) return;

    let category = select.value;
    if (category === "__new__") {
      category = newCatInput.value.trim();
      if (!category) {
        showToast("请输入分类名称。", true);
        return;
      }
    }

    const cmd = await this.addCommand(text, category);
    if (cmd) {
      showToast("已添加指令。");
    }
    this.closeAddDialog();
  }
}
```

- [ ] **Step 2: 删除 loadCommands() 函数及其调用**

在 `src/public/app.js` 中，删除以下内容：

1. `loadCommands()` 函数定义（第 551-611 行，从 `async function loadCommands() {` 到对应的闭合 `}`）
2. `loadCommands()` 调用（紧跟函数后面的 `loadCommands();`，约第 613 行）

- [ ] **Step 3: 提交**

```bash
git add src/public/app.js
git commit -m "feat(command-library): add CommandLibrary class with API integration"
```

---

### Task 3: 前端 — HTML 结构改造

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: 替换 Tab 导航和面板为统一指令库面板**

在 `src/public/index.html` 中，将第 118-138 行（Tab 导航 + Tab 内容区）：

```html
        <!-- 底部 Tab 面板 -->
        <nav class="tab-bar">
          <button id="tabQuick" class="tab-btn active" type="button">更多指令</button>
          <button id="tabPhrases" class="tab-btn" type="button">常用语 <span id="phrasesCount">(0)</span></button>
        </nav>

        <!-- Tab 内容区 -->
        <div class="tab-content">
          <div id="quickPanel" class="tab-panel">
            <div class="quick-btns" id="quickBtns"></div>
          </div>
          <div id="phrasesPanel" class="tab-panel hidden">
            <div class="phrases-header">
              <span>常用语 <span id="phrasesPanelCount">(0)</span></span>
              <div class="phrases-header-actions">
                <button id="phrasesAddBtn" class="phrases-add-btn" type="button">+ 新增</button>
                <button id="phrasesEditDoneBtn" class="phrases-edit-done-btn hidden" type="button">完成</button>
              </div>
            </div>
            <ul id="phrasesList" class="phrases-list"></ul>
          </div>
        </div>
```

替换为：

```html
        <!-- 指令库面板 -->
        <div class="library-panel">
          <div class="library-header">
            <span class="library-title">指令库</span>
            <div class="library-actions">
              <button id="cmdSearchToggle" class="icon-btn" type="button" title="搜索">
                <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/><line x1="21" y1="21" x2="16.65" y2="16.65" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
              <button id="cmdAddBtn" class="icon-btn add-btn" type="button"><span>+</span> 新增</button>
            </div>
          </div>
          <div id="cmdSearchBar" class="cmd-search-bar hidden">
            <input id="cmdSearchInput" class="cmd-search-input" type="text" placeholder="搜索指令…" />
          </div>
          <div id="commandLibrary" class="command-library"></div>
        </div>
```

- [ ] **Step 2: 替换常用语弹窗为新增指令弹窗**

将第 149-159 行（旧常用语弹窗）：

```html
    <!-- 新增常用语弹窗 -->
    <div id="addPhraseDialog" class="add-phrase-dialog hidden">
      <div class="add-phrase-overlay"></div>
      <div class="add-phrase-content">
        <h3>新增常用语</h3>
        <textarea id="addPhraseInput" class="add-phrase-input" rows="3" placeholder="输入常用语内容…"></textarea>
        <div class="add-phrase-actions">
          <button id="addPhraseCancelBtn" class="add-phrase-cancel-btn" type="button">取消</button>
          <button id="addPhraseConfirmBtn" class="add-phrase-confirm-btn" type="button">保存</button>
        </div>
      </div>
    </div>
```

替换为：

```html
    <!-- 新增指令弹窗 -->
    <div id="addCommandDialog" class="add-cmd-dialog hidden">
      <div class="add-cmd-overlay"></div>
      <div class="add-cmd-sheet">
        <div class="add-cmd-handle"></div>
        <div class="add-cmd-title">新增指令</div>
        <div class="add-cmd-label">指令内容</div>
        <textarea id="addCommandInput" class="add-cmd-textarea" rows="3" placeholder="输入指令内容…"></textarea>
        <div class="add-cmd-label">分类</div>
        <select id="addCommandCategory" class="add-cmd-select"></select>
        <input id="addCommandNewCategory" class="add-cmd-new-cat" type="text" placeholder="输入新分类名称…" />
        <div class="add-cmd-actions">
          <button id="addCmdCancelBtn" class="add-cmd-cancel" type="button">取消</button>
          <button id="addCmdConfirmBtn" class="add-cmd-confirm" type="button">保存</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 3: 提交**

```bash
git add src/public/index.html
git commit -m "refactor(html): replace tabs + phrases with unified command library panel"
```

---

### Task 4: 前端 — 删除旧代码并绑定新事件

**Files:**
- Modify: `src/public/app.js`

- [ ] **Step 1: 删除 PhrasesManager 类及其实例化**

删除 `src/public/app.js` 中以下内容：

1. `PhrasesManager` 类定义（第 298-448 行，从 `class PhrasesManager {` 到类的闭合 `}`）
2. `PhrasesManager` 实例化代码，搜索 `new PhrasesManager` 或 `phrases` 变量的初始化（约第 451 行附近的 `const phrases = new PhrasesManager({...})` 代码块）

- [ ] **Step 2: 删除 Tab 切换逻辑**

删除 `src/public/app.js` 第 467-485 行的 Tab Navigation 代码（从 `// === Tab Navigation ===` 到事件绑定结束）。

同时删除其中获取的 DOM 引用变量（`tabQuick`, `tabPhrases`, `quickPanel`, `phrasesPanel`）。

- [ ] **Step 3: 删除旧的收藏按钮事件绑定**

搜索 `phrases.el.saveBtn` 或 `savePhraseBtn` 相关的事件绑定代码。当前在约第 615-622 行：

```javascript
phrases.el.saveBtn.addEventListener("click", () => {
  const text = textInput.value.trim();
  if (text) {
    phrases.addPhrase(text);
    ...
  }
});
```

将这段替换为：

```javascript
document.getElementById("savePhraseBtn").addEventListener("click", () => {
  const text = textInput.value.trim();
  if (text) {
    commandLibrary.openAddDialog(text);
  }
});
```

- [ ] **Step 4: 删除旧的常用语弹窗事件绑定**

搜索 `addPhraseCancelBtn`、`addPhraseConfirmBtn`、`phrasesAddBtn`、`phrasesEditDoneBtn` 相关的事件绑定代码。删除所有这些事件绑定。

- [ ] **Step 5: 实例化 CommandLibrary 并绑定新事件**

在 app.js 的初始化区域（删除旧代码的位置附近），添加：

```javascript
// === Command Library 初始化 ===
const commandLibrary = new CommandLibrary(document.getElementById("commandLibrary"));

// 搜索按钮
document.getElementById("cmdSearchToggle").addEventListener("click", () => {
  const bar = document.getElementById("cmdSearchBar");
  bar.classList.toggle("hidden");
  if (!bar.classList.contains("hidden")) {
    document.getElementById("cmdSearchInput").focus();
  } else {
    document.getElementById("cmdSearchInput").value = "";
    commandLibrary.render();
  }
});

// 搜索输入
document.getElementById("cmdSearchInput").addEventListener("input", (e) => {
  commandLibrary.render(e.target.value);
});

// 新增按钮
document.getElementById("cmdAddBtn").addEventListener("click", () => {
  commandLibrary.openAddDialog();
});

// 新增弹窗事件
document.getElementById("addCmdCancelBtn").addEventListener("click", () => {
  commandLibrary.closeAddDialog();
});
document.getElementById("addCmdConfirmBtn").addEventListener("click", () => {
  commandLibrary.confirmAdd();
});
document.getElementById("addCommandCategory").addEventListener("change", (e) => {
  const newCatInput = document.getElementById("addCommandNewCategory");
  if (e.target.value === "__new__") {
    newCatInput.classList.add("show");
    newCatInput.focus();
  } else {
    newCatInput.classList.remove("show");
  }
});
document.getElementById("addCommandDialog").querySelector(".add-cmd-overlay").addEventListener("click", () => {
  commandLibrary.closeAddDialog();
});
```

- [ ] **Step 6: 提交**

```bash
git add src/public/app.js
git commit -m "refactor(app): remove PhrasesManager + tabs, wire CommandLibrary events"
```

---

### Task 5: 前端 — CSS 样式

**Files:**
- Modify: `src/public/style.css`

- [ ] **Step 1: 删除旧样式**

在 `src/public/style.css` 中删除以下选择器对应的规则块：

- `.tab-bar`（第 710-720 行）
- `.tab-btn`（第 722-737 行）
- `.tab-btn.active`（第 739-743 行）
- `.tab-content`（第 746-754 行）
- `.tab-panel`（第 756-760 行）
- `.quick-btns`（第 763-769 行）
- `.quick-btn`（第 771-791 行）
- `.quick-btn svg`（第 793-802 行）
- `.phrases-header`（第 814-826 行）
- `.phrases-header-actions`（第 828-832 行）
- `.phrases-add-btn, .phrases-edit-done-btn`（第 834-845 行）
- `.phrases-list`（第 847-853 行）
- `.phrases-list:empty::after`（第 855-862 行）
- `.phrases-item` 及其子选择器（第 864-917 行）
- `.add-phrase-dialog` 及其子选择器（第 1046-1119 行）
- `.phrases-item.editing`（dark mode，第 1234-1236 行）
- `.add-phrase-input`（dark mode，第 1243-1245 行）
- `.tab-bar`（dark mode，第 1252-1254 行）
- `.tab-btn.active`（dark mode，第 1256-1258 行）
- `.quick-btns`（responsive，第 1164-1167 行）

- [ ] **Step 2: 添加新样式**

在 `src/public/style.css` 中（删除旧样式后的位置）添加：

```css
/* === 指令库面板 === */
.library-panel {
  padding: 0 4px;
}
.library-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
.library-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}
.library-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.icon-btn {
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 18px;
  transition: all 0.15s;
  gap: 4px;
}
.icon-btn:active {
  background: var(--accent-dim);
  color: var(--accent);
}
.icon-btn svg {
  display: block;
}
.icon-btn.add-btn {
  color: var(--accent);
  border-color: var(--accent);
  background: transparent;
  font-size: 14px;
  font-weight: 500;
}
.icon-btn.add-btn span {
  font-size: 20px;
  line-height: 1;
}

/* 搜索栏 */
.cmd-search-bar {
  margin-bottom: 12px;
}
.cmd-search-bar.hidden {
  display: none;
}
.cmd-search-input {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
}
.cmd-search-input:focus {
  border-color: var(--accent);
}
.cmd-search-input::placeholder {
  color: var(--text-muted);
}

/* 分类组 */
.category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 4px;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.category-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.category-arrow {
  color: var(--text-muted);
  font-size: 12px;
  transition: transform 0.2s;
  display: inline-block;
}
.category-arrow.collapsed {
  transform: rotate(-90deg);
}
.category-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
.category-count {
  font-size: 12px;
  color: var(--text-muted);
  background: var(--accent-dim);
  padding: 1px 6px;
  border-radius: 10px;
}

/* 指令按钮网格 */
.cmd-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0 8px;
  overflow: hidden;
  transition: max-height 0.25s ease, opacity 0.15s;
  max-height: 500px;
}
.cmd-grid.collapsed {
  max-height: 0;
  opacity: 0;
  padding: 0;
  margin: 0;
}
.cmd-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 14px;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  outline: none;
}
.cmd-btn:active {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
  transform: scale(0.96);
}
.cmd-btn.slash {
  background: rgba(255, 140, 66, 0.08);
  color: var(--accent);
  border-color: rgba(255, 140, 66, 0.3);
  font-family: "SF Mono", Menlo, "Courier New", monospace;
  font-size: 12px;
}
.cmd-btn.editing {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
  cursor: text;
}
.cmd-btn.dimmed {
  opacity: 0.3;
  pointer-events: none;
}

/* 编辑操作栏 */
.cmd-edit-actions {
  display: flex;
  gap: 8px;
  padding: 4px 0 12px;
}
.cmd-delete-btn {
  padding: 6px 14px;
  background: rgba(255, 107, 107, 0.15);
  border: 1px solid rgba(255, 107, 107, 0.3);
  border-radius: var(--radius-sm);
  color: var(--danger, #ff6b6b);
  font-size: 12px;
  cursor: pointer;
}
.cmd-done-btn {
  margin-left: auto;
  padding: 6px 14px;
  background: var(--accent-dim);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

/* 新增指令弹窗 */
.add-cmd-dialog.hidden {
  display: none;
}
.add-cmd-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 100;
}
.add-cmd-sheet {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border-radius: 20px 20px 0 0;
  padding: 16px 20px 32px;
  border-top: 1px solid var(--border);
  z-index: 101;
  max-width: 430px;
  margin: 0 auto;
}
.add-cmd-handle {
  width: 36px;
  height: 4px;
  background: var(--text-muted);
  border-radius: 2px;
  margin: 0 auto 16px;
  opacity: 0.5;
}
.add-cmd-title {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 14px;
  color: var(--text-primary);
}
.add-cmd-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.add-cmd-textarea {
  width: 100%;
  min-height: 60px;
  padding: 10px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 14px;
  resize: none;
  outline: none;
  margin-bottom: 14px;
  font-family: inherit;
}
.add-cmd-textarea:focus {
  border-color: var(--accent);
}
.add-cmd-select {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  appearance: none;
  margin-bottom: 14px;
  cursor: pointer;
}
.add-cmd-select:focus {
  border-color: var(--accent);
}
.add-cmd-new-cat {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  margin-bottom: 14px;
  display: none;
}
.add-cmd-new-cat.show {
  display: block;
}
.add-cmd-actions {
  display: flex;
  gap: 10px;
}
.add-cmd-cancel {
  flex: 1;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-secondary);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
}
.add-cmd-confirm {
  flex: 1;
  padding: 12px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}
.add-cmd-confirm:active {
  opacity: 0.85;
}

/* 暗色模式补充（如果需要） */
@media (prefers-color-scheme: dark) {
  .add-cmd-new-cat {
    background: var(--bg-card);
    border-color: var(--border);
    color: var(--text-primary);
  }
}
```

注意：部分 CSS 变量（如 `--accent-dim`, `--border`, `--bg-tertiary`, `--bg-card`, `--text-secondary`, `--text-muted`）已经在现有暗色主题中定义。如果 `--accent-dim` 未定义，需要在 `:root` 或暗色主题变量中添加：

```css
--accent-dim: rgba(255, 140, 66, 0.15);
```

检查 `style.css` 中是否已有此变量。如果没有，添加到 CSS 变量定义区域。

- [ ] **Step 3: 提交**

```bash
git add src/public/style.css
git commit -m "style(command-library): add unified command library styles, remove tabs and phrases styles"
```

---

### Task 6: localStorage 常用语迁移

**Files:**
- Modify: `src/public/app.js`

- [ ] **Step 1: 在 CommandLibrary.load() 中添加 localStorage 迁移逻辑**

在 `CommandLibrary` 的 `load()` 方法中，API 加载成功后检查 localStorage 中是否有旧常用语数据，自动迁移：

修改 `CommandLibrary.load()` 方法为：

```javascript
async load() {
  try {
    const res = await fetch("/api/commands");
    this.commands = await res.json();

    // 迁移 localStorage 中的旧常用语
    this._migrateLocalStoragePhrases();

    this.render();
  } catch {
    // 静默失败
  }
}

_migrateLocalStoragePhrases() {
  const STORAGE_KEY = "voicebridge_phrases";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const phrases = JSON.parse(raw);
    if (!Array.isArray(phrases) || phrases.length === 0) return;

    // 检查是否已经迁移过
    const migratedKey = "voicebridge_phrases_migrated";
    if (localStorage.getItem(migratedKey)) return;

    // 批量迁移到服务端
    for (const phrase of phrases) {
      if (phrase.text) {
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: phrase.text,
            label: phrase.text.length > 8 ? phrase.text.slice(0, 8) + "…" : phrase.text,
            category: "通用",
          }),
        });
      }
    }

    localStorage.setItem(migratedKey, "true");
    // 重新加载以获取包含迁移数据的结果
    fetch("/api/commands")
      .then((r) => r.json())
      .then((cmds) => {
        this.commands = cmds;
        this.render();
      })
      .catch(() => {});
  } catch {
    // 静默失败
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/public/app.js
git commit -m "feat(command-library): auto-migrate localStorage phrases to server"
```

---

### Task 7: 验证与收尾

- [ ] **Step 1: 启动服务验证**

1. `npm start` 启动服务
2. 打开浏览器访问，确认：
   - 指令库面板正确渲染，按分类分组
   - commands.json 旧格式已自动迁移为新格式
   - 点击指令按钮能正常发送到电脑
   - 搜索功能正常过滤
   - 分类折叠/展开正常
   - 长按进入编辑模式，编辑和删除正常
   - "+ 新增"弹窗正常弹出，能选择分类和新建分类
   - 收藏按钮弹出新增弹窗并预填文本
   - localStorage 旧常用语自动迁移（如果有的话）

- [ ] **Step 2: 最终提交（如有修复）**

```bash
git add -A
git commit -m "fix(command-library): final adjustments from manual testing"
```
