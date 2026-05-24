# VoiceBridge 移动端前端重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 VoiceBridge 移动端前端重设计为紧凑单页布局、温润质感视觉风格、基于使用频率的快捷指令自动置顶。

**Architecture:** 三个文件全面重写（HTML 结构、CSS 样式、JS 逻辑）。CSS 使用 CSS 变量实现设计 token（亮/暗色模式），JS 新增 RecentCommands 类管理最近指令，连接状态从文字改为圆点指示器 + toast，自动粘贴从 checkbox 改为 toggle 开关。所有三个文件需要同步改，因此每个 Task 同时修改三个文件并提交。

**Tech Stack:** 纯 HTML/CSS/JS（无框架），localStorage 持久化

---

### Task 1: 重构 HTML 结构

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: 重写 index.html 的 body 内容**

将 `<main class="shell"><section class="panel">` 内的全部内容替换为新布局结构。保留 `<script>` 和 `<div id="addPhraseDialog">` 不变。

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>VoiceBridge</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <main class="shell">
      <div class="panel">
        <!-- 顶栏 -->
        <div class="topbar">
          <span class="brand">VoiceBridge</span>
          <div class="topbar-actions">
            <button id="statusDot" class="status-dot connecting" type="button" title="正在连接"></button>
            <div class="window-selector">
              <button id="windowBtn" class="window-btn" type="button">
                <span id="windowBtnLabel">光标位置</span>
                <span class="window-btn-arrow">&#x25BE;</span>
              </button>
              <div id="windowDropdown" class="window-dropdown hidden">
                <div id="windowList" class="window-list">
                  <p class="window-list-loading">加载中…</p>
                </div>
                <button id="windowRefreshBtn" class="window-refresh-btn" type="button">刷新</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 最近指令 -->
        <div id="recentBar" class="recent-bar hidden">
          <button class="recent-tag" data-text="" type="button"></button>
        </div>

        <!-- 文本输入 -->
        <textarea id="textInput" class="text-input" placeholder="输入文字，或语音识别…" enterkeyhint="send" rows="2"></textarea>

        <!-- 操作按钮行 -->
        <div class="action-row">
          <button id="recordButton" class="record-button" type="button">
            <span class="record-icon record-icon-mic">
              <svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
            </span>
            <span class="record-label">录音</span>
          </button>
          <button id="undoButton" class="action-btn" type="button" title="撤销">
            <svg viewBox="0 0 24 24" width="16" height="16"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
          </button>
          <button id="enterButton" class="action-btn" type="button" title="回车">
            <svg viewBox="0 0 24 24" width="16" height="16"><polyline points="13 17 18 12 13 7"/><line x1="6" y1="12" x2="18" y2="12"/></svg>
          </button>
        </div>

        <!-- 兜底上传 -->
        <button id="fallbackButton" class="fallback-button hidden" type="button">录音或选择音频上传</button>
        <input id="fallbackFile" class="hidden" type="file" accept="audio/*" capture />

        <!-- 折叠栏：更多指令 -->
        <div id="quickBar" class="collapse-bar">
          <button id="quickToggle" class="collapse-toggle" type="button">
            <span class="collapse-arrow">&#x25B8;</span> 更多指令
          </button>
          <div id="quickPanel" class="collapse-panel hidden">
            <div class="quick-group">
              <span class="quick-group-label">命令</span>
              <div class="quick-btns">
                <button class="quick-btn" data-text="/clear">clear</button>
                <button class="quick-btn" data-text="/git-commit">commit</button>
                <button class="quick-btn" data-text="/writing-plans">plan</button>
              </div>
            </div>
            <div class="quick-group">
              <span class="quick-group-label">分析</span>
              <div class="quick-btns">
                <button class="quick-btn" data-text="先系统地查看相关代码，告诉我代码之间的联系和实现情况，我们先讨论">代码关联</button>
                <button class="quick-btn" data-text="先问是哪部分代码控制的这个功能，再改">问清再改</button>
                <button class="quick-btn" data-text="哪个方式最优？我需要质量最好的方案，我不嫌麻烦">最优方案</button>
                <button class="quick-btn" data-text="我们以目标作为导向来进行讨论吧。我们从最终能实现什么样的功能来往回推导微调方案">目标导向</button>
              </div>
            </div>
            <div class="quick-group">
              <span class="quick-group-label">决策</span>
              <div class="quick-btns">
                <button class="quick-btn" data-text="我有没有说清楚我的需求，有什么问题可以问我，为了确认你清楚了，先系统地查看相关代码，然后你可以说一下你的大致执行计划，不用太具体，也不用给出代码，就告诉我你大概怎么做就可以了。等我确认后再执行">需求确认</button>
                <button class="quick-btn" data-text="可以按照你推荐的方案来执行，告诉我你准备分几步实现？每一步大致准备怎么做？不需要给出具体代码和具体步骤，用最简洁的话语来总结你的做法就可以，等我决策之后再执行。">计划概述</button>
              </div>
            </div>
            <div class="quick-group">
              <span class="quick-group-label">Git</span>
              <div class="quick-btns">
                <button class="quick-btn" data-text="将当前状态通过 git 保存并打个 tag，tag 往后编号">保存tag</button>
              </div>
            </div>
            <div class="quick-group">
              <span class="quick-group-label">风格</span>
              <div class="quick-btns">
                <button class="quick-btn" data-text="汝以文言作答。凡回复，惜字如金，不赘不饰。先行后言，果先因后。若无必要，勿增实体。">文言模式</button>
              </div>
            </div>
            <div class="quick-group">
              <span class="quick-group-label">Subagent</span>
              <div class="quick-btns">
                <button class="quick-btn" data-text="审查审查再审查，看看还有没有可以优化的地方">sub审查</button>
                <button class="quick-btn" data-text="换个角度再审查一遍，看看还有没有可以优化的地方">换角审查</button>
                <button class="quick-btn" data-text="帮我使用subagent系统全面地巡检当前系统，看看有没有什么重大的bug和可以优化的地方？可以先把巡检任务拆分成多个子任务，再分配给subagent来执行">系统巡检</button>
                <button class="quick-btn" data-text="使用subagent实测一下刚刚进行的改动，确保优化是有效的，再审查一下有没有新的问题出现。测试的过程中记得及时记录出现的问题。成本小的问题直接修复，最小化修复原则，比较难的以及需要我决策的问题我们再讨论">实测改动</button>
                <button class="quick-btn" data-text="先使用subagent完成修复成本低但收益大的任务，然后派subagent更新计划文档。那些问题没有澄清的和比较难的任务先搁置着，我们讨论后再决定">快修慢议</button>
                <button class="quick-btn" data-text="仔细深入全面分析这个项目，对于每个子系统都使用最高规格的subagent进行深入研究，尽可能多开subagent以进行尽可能详尽深入的研究，力求全面理解整个项目">全面分析</button>
                <button class="quick-btn" data-text='做最后一轮"挑刺式复查"，重点检查有没有我自己刚引入的新歧义，比如接口命名冲突、phase依赖前后不一致、或者事件流图和phase细节打架。使用subagent逐项优化以上问题。尽量最小化修复。修复过程有更好的方案可以推翻之前的代码和架构，此时可以不用管"最小化修复"原则'>末轮复查</button>
              </div>
            </div>
            <div class="quick-group">
              <span class="quick-group-label">其他</span>
              <div class="quick-btns">
                <button class="quick-btn" data-text="你能把刚刚我们讨论的重点内容以及要执行的文档记下来吗？我要压缩一下上下文，然后用subagent-driven来执行。我待会clear后对你说啥你就能继续接着刚刚我们讨论过的来干？">记笔记</button>
                <button class="quick-btn" data-text="当前项目我应该怎么用？给我一份详细的使用说明。我们一步一步来配置，你也一步一步引导我，我完成一步你再告诉我下一步要干啥。首先第一步干啥？">怎么用</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 折叠栏：常用语 -->
        <div id="phrasesDrawer" class="collapse-bar">
          <button id="phrasesToggle" class="collapse-toggle" type="button">
            <span class="collapse-arrow">&#x25B8;</span> 常用语 <span id="phrasesCount">(0)</span>
          </button>
          <div id="phrasesPanel" class="collapse-panel hidden">
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

        <!-- 底栏 -->
        <div class="bottom-bar">
          <button id="savePhraseBtn" class="save-btn hidden" type="button">
            <svg viewBox="0 0 24 24" width="14" height="14"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            收藏
          </button>
          <label class="toggle-switch">
            <input id="autoPaste" type="checkbox" checked />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-label">自动粘贴</span>
          </label>
        </div>
      </div>
    </main>

    <!-- Toast -->
    <div id="toast" class="toast hidden"></div>

    <script src="/app.js" type="module"></script>

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
  </body>
</html>
```

- [ ] **Step 2: 在浏览器中验证 HTML 结构正确渲染**

Run: `cd /Users/hl/Projects/VoiceBridge && npm start`（在手机浏览器打开页面）
Expected: 页面结构可看到，但样式尚未应用（因为 CSS 还未更新）。各元素 ID 和类名与新 HTML 一致。

- [ ] **Step 3: 提交 HTML 结构**

```bash
git add src/public/index.html
git commit -m "refactor(frontend): restructure HTML to compact single-page layout"
```

---

### Task 2: 重写 CSS 样式（亮色模式）

**Files:**
- Modify: `src/public/style.css`

- [ ] **Step 1: 用新的设计系统重写 style.css（亮色模式部分）**

完全替换 `src/public/style.css` 内容。使用 CSS 变量定义 design token，温润质感风格。此步只写亮色模式，暗色模式在 Task 3。

```css
/* === Design Tokens === */
:root {
  --bg-page: #faf9f7;
  --bg-card: #ffffff;
  --bg-input: #ffffff;
  --bg-tag: #f0efeb;
  --bg-collapse: #f0efeb;
  --bg-collapse-header: #f5f4f0;

  --text-primary: #1a1a1a;
  --text-secondary: #78716c;
  --text-muted: #a8a29e;
  --text-placeholder: #a8a29e;

  --border: #e7e5e4;
  --border-focus: #166534;

  --accent: #166534;
  --accent-text: #ffffff;
  --danger: #b91c1c;
  --danger-text: #ffffff;
  --muted: #78716c;
  --muted-text: #ffffff;

  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.04);
  --radius: 8px;
  --radius-sm: 6px;
  --radius-tag: 6px;

  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg-page);
  color: var(--text-primary);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  -webkit-tap-highlight-color: transparent;
}

.hidden { display: none; }

/* === Shell & Panel === */
.shell {
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 16px;
}

.panel {
  width: min(100%, 420px);
  display: grid;
  gap: 10px;
  align-content: start;
}

/* === Top Bar === */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.brand {
  font-weight: 700;
  font-size: 15px;
  color: var(--text-primary);
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* === Status Dot === */
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}

.status-dot.connected {
  background: #166534;
}

.status-dot.error {
  background: #b91c1c;
}

.status-dot.connecting {
  background: #a8a29e;
  animation: blink 1.5s ease-in-out infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* === Toast === */
.toast {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: var(--radius);
  background: var(--text-primary);
  color: var(--bg-page);
  font-size: 12px;
  font-weight: 500;
  z-index: 200;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
}

.toast:not(.hidden) {
  opacity: 1;
}

.toast.error {
  background: var(--danger);
  color: var(--danger-text);
}

/* === Window Selector === */
.window-selector {
  position: relative;
}

.window-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s;
  box-shadow: var(--shadow-sm);
}

.window-btn:hover { border-color: var(--accent); }

.window-btn.active {
  border-color: var(--accent);
  color: var(--accent);
  background: #f0fdf4;
}

.window-btn-arrow {
  font-size: 10px;
  color: var(--text-muted);
}

.window-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  width: 260px;
  max-height: 320px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  flex-direction: column;
  z-index: 100;
}

.window-dropdown:not(.hidden) { display: flex; }

.window-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.window-list-loading,
.window-list-empty {
  padding: 16px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}

.window-app-group {
  border-bottom: 1px solid var(--bg-tag);
}

.window-app-group:last-child { border-bottom: 0; }

.window-app-label {
  padding: 4px 10px 2px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.window-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  background: none;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
}

.window-item:hover { background: var(--bg-tag); }

.window-item.selected {
  background: #f0fdf4;
  color: var(--accent);
  font-weight: 600;
}

.window-item-check { width: 14px; font-size: 11px; flex-shrink: 0; }

.window-item-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.window-refresh-btn {
  display: block;
  width: 100%;
  padding: 6px;
  border: 0;
  border-top: 1px solid var(--bg-tag);
  background: none;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
}

.window-refresh-btn:hover { background: var(--bg-tag); color: var(--text-primary); }

/* === Recent Bar === */
.recent-bar {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.recent-tag {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-tag);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  touch-action: manipulation;
  transition: background 0.15s, border-color 0.15s;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-shadow: var(--shadow-sm);
}

.recent-tag:active {
  background: var(--accent);
  color: var(--accent-text);
  border-color: var(--accent);
}

/* === Text Input === */
.text-input {
  width: 100%;
  min-height: 60px;
  max-height: 120px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  word-break: break-word;
  resize: none;
  overflow-y: auto;
  transition: border-color 0.15s;
  box-shadow: var(--shadow-sm);
}

.text-input:focus {
  outline: none;
  border-color: var(--border-focus);
}

.text-input::placeholder {
  color: var(--text-placeholder);
}

/* === Action Row === */
.action-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.record-button {
  flex: 1;
  min-height: 42px;
  border: 0;
  border-radius: var(--radius);
  background: var(--accent);
  color: var(--accent-text);
  font-size: 13px;
  font-weight: 600;
  touch-action: manipulation;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.record-button:disabled {
  background: var(--muted);
  cursor: not-allowed;
}

.record-button.recording {
  background: var(--danger);
  animation: none;
}

.record-icon {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.record-icon svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.record-icon-stop svg {
  stroke-width: 0;
}

.record-icon-stop svg rect {
  fill: currentColor;
}

.record-button.recording .record-icon {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.3); }
  50% { box-shadow: 0 0 0 6px rgba(255, 255, 255, 0); }
}

.record-label {
  font-size: 13px;
  font-weight: 600;
}

.action-btn {
  width: 42px;
  min-height: 42px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  touch-action: manipulation;
  box-shadow: var(--shadow-sm);
  transition: background 0.15s;
}

.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-btn svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.fallback-button {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

/* === Collapse Bar === */
.collapse-bar {
  display: flex;
  flex-direction: column;
}

.collapse-toggle {
  width: 100%;
  min-height: 32px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--bg-collapse);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  cursor: pointer;
  touch-action: manipulation;
}

.collapse-arrow {
  font-size: 10px;
  transition: transform 0.2s;
  display: inline-block;
}

.collapse-bar.open .collapse-arrow {
  transform: rotate(90deg);
}

.collapse-panel {
  margin-top: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  max-height: 200px;
  overflow-y: auto;
}

/* === Quick Commands === */
.quick-group {
  border-bottom: 1px solid var(--bg-tag);
}

.quick-group:last-child { border-bottom: none; }

.quick-group-label {
  display: block;
  padding: 4px 10px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  background: var(--bg-collapse-header);
}

.quick-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 10px;
}

.quick-btn {
  border: 1px solid var(--border);
  border-radius: var(--radius-tag);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 500;
  padding: 3px 8px;
  cursor: pointer;
  touch-action: manipulation;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  white-space: nowrap;
}

.quick-btn:active {
  background: var(--accent);
  color: var(--accent-text);
  border-color: var(--accent);
}

/* === Phrases === */
.phrases-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 10px;
  background: var(--bg-collapse-header);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}

.phrases-header-actions {
  display: flex;
  gap: 8px;
}

.phrases-add-btn,
.phrases-edit-done-btn {
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

.phrases-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 150px;
  overflow-y: auto;
}

.phrases-list:empty::after {
  content: "暂无常用语，点击"+ 新增"添加";
  display: block;
  padding: 12px 10px;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
}

.phrases-item {
  padding: 7px 10px;
  border-bottom: 1px solid var(--bg-tag);
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
  display: flex;
  align-items: center;
  gap: 6px;
}

.phrases-item:last-child { border-bottom: none; }
.phrases-item:active { background: var(--bg-tag); }

.phrases-item.editing {
  cursor: default;
  background: #fffde8;
  border-left: 3px solid #eab308;
}

.phrases-item-text {
  flex: 1;
  word-break: break-word;
  line-height: 1.4;
}

.phrases-item-edit-input {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.4;
  resize: none;
  background: var(--bg-card);
  color: var(--text-primary);
}

.phrases-item-delete {
  border: 0;
  background: none;
  color: #dc2626;
  font-size: 10px;
  cursor: pointer;
  padding: 2px 6px;
  white-space: nowrap;
  border-radius: 4px;
}

.phrases-item-delete:hover { background: #fecaca; }

/* === Bottom Bar === */
.bottom-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 4px;
}

.save-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
}

.save-btn svg { flex-shrink: 0; }

.save-btn.saved {
  background: var(--muted);
  pointer-events: none;
}

/* Toggle Switch */
.toggle-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  margin: 0;
  user-select: none;
}

.toggle-switch input { display: none; }

.toggle-track {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--border);
  transition: background 0.2s;
}

.toggle-switch input:checked + .toggle-track {
  background: var(--accent);
}

.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--bg-card);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  transition: transform 0.2s;
}

.toggle-switch input:checked + .toggle-track .toggle-thumb {
  transform: translateX(16px);
}

.toggle-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}

/* === Add Phrase Dialog === */
.add-phrase-dialog {
  position: fixed;
  inset: 0;
  z-index: 100;
}

.add-phrase-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
}

.add-phrase-content {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  max-width: 420px;
  margin: 0 auto;
  background: var(--bg-card);
  border-radius: 12px 12px 0 0;
  padding: 20px;
  z-index: 101;
}

.add-phrase-content h3 {
  margin: 0 0 12px;
  font-size: 16px;
  color: var(--text-primary);
}

.add-phrase-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px;
  font-size: 13px;
  font-family: inherit;
  resize: none;
  line-height: 1.5;
  background: var(--bg-page);
  color: var(--text-primary);
}

.add-phrase-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.add-phrase-cancel-btn {
  flex: 1;
  min-height: 38px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.add-phrase-confirm-btn {
  flex: 1;
  min-height: 38px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.add-phrase-confirm-btn:disabled {
  background: var(--muted);
  cursor: not-allowed;
}
```

- [ ] **Step 2: 在浏览器中验证亮色模式样式**

Expected: 温润质感的暖色调 UI，紧凑布局，所有组件正确渲染。录音按钮为行内宽度。

- [ ] **Step 3: 提交 CSS 亮色模式**

```bash
git add src/public/style.css
git commit -m "style(frontend): rewrite CSS with warm texture design system (light mode)"
```

---

### Task 3: 添加暗色模式 CSS

**Files:**
- Modify: `src/public/style.css`

- [ ] **Step 1: 在 style.css 末尾追加暗色模式媒体查询**

在文件最后追加以下内容，覆盖 CSS 变量实现暗色模式：

```css
@media (prefers-color-scheme: dark) {
  :root {
    --bg-page: #1a1918;
    --bg-card: #2a2928;
    --bg-input: #2a2928;
    --bg-tag: #252423;
    --bg-collapse: #252423;
    --bg-collapse-header: #2f2e2c;

    --text-primary: #f4f4f0;
    --text-secondary: #a8a29e;
    --text-muted: #78716c;
    --text-placeholder: #78716c;

    --border: #3b3938;
    --border-focus: #22c55e;

    --accent: #22c55e;
    --accent-text: #052e16;
    --danger: #ef4444;
    --danger-text: #ffffff;
    --muted: #57534e;
    --muted-text: #ffffff;

    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .status-dot.connected { background: #22c55e; }
  .status-dot.error { background: #ef4444; }

  .window-btn { background: var(--bg-card); }
  .window-btn.active { background: #052e16; }

  .window-dropdown {
    background: var(--bg-card);
    border-color: var(--border);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .window-item { color: var(--text-primary); }
  .window-item:hover { background: var(--bg-tag); }
  .window-item.selected { background: #052e16; color: #22c55e; }

  .recent-tag { background: var(--bg-card); }

  .text-input { background: var(--bg-input); }
  .text-input::placeholder { color: var(--text-placeholder); }

  .action-btn { background: var(--bg-card); color: var(--text-muted); }

  .phrases-item { color: var(--text-primary); border-bottom-color: var(--bg-tag); }
  .phrases-item:active { background: var(--bg-tag); }
  .phrases-item.editing { background: #2a2510; }
  .phrases-item-edit-input { background: var(--bg-card); border-color: var(--border); color: var(--text-primary); }

  .phrases-item-delete:hover { background: #3b1515; }

  .add-phrase-content { background: var(--bg-card); }
  .add-phrase-content h3 { color: var(--text-primary); }
  .add-phrase-input { background: var(--bg-page); border-color: var(--border); color: var(--text-primary); }
  .add-phrase-cancel-btn { background: var(--bg-card); border-color: var(--border); color: var(--text-secondary); }

  .toggle-thumb { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); }
}
```

- [ ] **Step 2: 验证暗色模式**

在手机系统设置中切换到暗色模式，刷新页面。
Expected: 深色暖灰背景，绿色强调色，所有组件暗色适配。

- [ ] **Step 3: 提交暗色模式**

```bash
git add src/public/style.css
git commit -m "style(frontend): add dark mode support"
```

---

### Task 4: 重写 app.js — 基础结构和连接状态

**Files:**
- Modify: `src/public/app.js`

- [ ] **Step 1: 重写 app.js 的顶部（元素引用、sendTextInput、appendToTextInput、RecentCommands 类、toast 函数、连接状态）**

替换 `app.js` 中从第 1 行到 `connectWebSocket()` 调用之前的所有代码。保留 `WindowSelector`、`PhrasesManager`、录音相关函数、`connectWebSocket`、`uploadAudio` 等不变，但需要适配新的元素 ID 和类名。

完整的新 `app.js` 内容（因为改动涉及全文，提供完整文件）：

```javascript
// === Element References ===
const statusDot = document.querySelector("#statusDot");
const textInput = document.querySelector("#textInput");
const autoPasteEl = document.querySelector("#autoPaste");
const toastEl = document.querySelector("#toast");

// === Toast ===
let toastTimer = null;

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.toggle("error", isError);
  toastEl.classList.remove("hidden");
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2500);
}

// === Status Dot ===
function setConnectionStatus(state, message) {
  statusDot.className = "status-dot " + state;
  statusDot.title = message;
}

statusDot.addEventListener("click", () => {
  showToast(statusDot.title);
});

// === Text Input ===
function sendTextInput() {
  const text = textInput.value.trim();
  if (!text) return;
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
    textInput.value = "";
    phrases.hideSaveButton();
    showToast("已发送到电脑。");
  } else {
    showToast("发送失败，请检查连接。", true);
  }
}

function appendToTextInput(text) {
  if (!text) return;
  const current = textInput.value;
  if (!current.trim()) {
    textInput.value = text;
  } else {
    const lastChar = current.trimEnd().slice(-1);
    const separator = /[，。！？、；：\.\!\?\,\;\:]$/.test(lastChar) ? " " : "";
    textInput.value = current.trimEnd() + separator + text;
  }
  textInput.scrollTop = textInput.scrollHeight;
}

// === Record Button ===
const recordButton = document.querySelector("#recordButton");
const enterButton = document.querySelector("#enterButton");
const undoButton = document.querySelector("#undoButton");
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
    if (this.selectedWindow) localStorage.setItem(WindowSelector.STORAGE_KEY, JSON.stringify(this.selectedWindow));
    else localStorage.removeItem(WindowSelector.STORAGE_KEY);
  }

  _toggle() { this._isOpen ? this._close() : this._open(); }
  _open() { this._isOpen = true; this.el.dropdown.classList.remove("hidden"); this._fetchWindows(); }
  _close() { this._isOpen = false; this.el.dropdown.classList.add("hidden"); }

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
        const isSelected = this.selectedWindow && this.selectedWindow.appName === group.appName && this.selectedWindow.windowTitle === win.title;
        if (isSelected) btn.classList.add("selected");
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

// === RecentCommands ===
class RecentCommands {
  static STORAGE_KEY = "voicebridge_recent_commands";
  static MAX_ITEMS = 6;
  static MAX_LABEL_LEN = 8;

  constructor(containerEl) {
    this.container = containerEl;
    this._commands = this._load();
    this._render();
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(RecentCommands.STORAGE_KEY)) || []; } catch { return []; }
  }

  _save() {
    localStorage.setItem(RecentCommands.STORAGE_KEY, JSON.stringify(this._commands));
  }

  record(text, label) {
    const entry = { text, label, ts: Date.now() };
    this._commands = this._commands.filter((c) => c.text !== text);
    this._commands.unshift(entry);
    this._commands = this._commands.slice(0, RecentCommands.MAX_ITEMS);
    this._save();
    this._render();
  }

  _truncate(str) {
    if (str.length <= RecentCommands.MAX_LABEL_LEN) return str;
    return str.slice(0, RecentCommands.MAX_LABEL_LEN) + "…";
  }

  _render() {
    this.container.innerHTML = "";
    if (this._commands.length === 0) {
      this.container.classList.add("hidden");
      return;
    }
    this.container.classList.remove("hidden");
    this._commands.forEach((cmd) => {
      const btn = document.createElement("button");
      btn.className = "recent-tag";
      btn.type = "button";
      btn.dataset.text = cmd.text;
      btn.textContent = this._truncate(cmd.label);
      btn.title = cmd.text;
      this.container.appendChild(btn);
    });
  }
}

// === PhrasesManager (unchanged) ===
class PhrasesManager {
  static STORAGE_KEY = "voicebridge_phrases";

  constructor() {
    this.el = {
      drawer: document.querySelector("#phrasesDrawer"),
      toggle: document.querySelector("#phrasesToggle"),
      panel: document.querySelector("#phrasesPanel"),
      list: document.querySelector("#phrasesList"),
      count: document.querySelector("#phrasesCount"),
      panelCount: document.querySelector("#phrasesPanelCount"),
      addBtn: document.querySelector("#phrasesAddBtn"),
      editDoneBtn: document.querySelector("#phrasesEditDoneBtn"),
      saveBtn: document.querySelector("#savePhraseBtn"),
      dialog: document.querySelector("#addPhraseDialog"),
      dialogOverlay: document.querySelector(".add-phrase-overlay"),
      dialogInput: document.querySelector("#addPhraseInput"),
      dialogCancel: document.querySelector("#addPhraseCancelBtn"),
      dialogConfirm: document.querySelector("#addPhraseConfirmBtn"),
    };
    this.editingId = null;
    this._init();
  }

  _init() {
    this.el.toggle.addEventListener("click", () => this._toggle());
    this.el.addBtn.addEventListener("click", () => this._openAddDialog());
    this.el.dialogCancel.addEventListener("click", () => this._closeDialog());
    this.el.dialogOverlay.addEventListener("click", () => this._closeDialog());
    this.el.dialogConfirm.addEventListener("click", () => this._confirmAdd());
    this.el.editDoneBtn.addEventListener("click", () => this._exitEditMode());
    this._render();
  }

  get _phrases() { try { return JSON.parse(localStorage.getItem(PhrasesManager.STORAGE_KEY)) || []; } catch { return []; } }
  set _phrases(arr) { localStorage.setItem(PhrasesManager.STORAGE_KEY, JSON.stringify(arr)); }

  _updateCounts() {
    const n = this._phrases.length;
    this.el.count.textContent = `(${n})`;
    this.el.panelCount.textContent = `(${n})`;
  }

  _toggle() {
    this.el.drawer.classList.toggle("open");
    this.el.panel.classList.toggle("hidden");
    if (this.el.drawer.classList.contains("open")) this._exitEditMode();
  }

  _render() {
    const phrases = this._phrases;
    this._updateCounts();
    this.el.list.innerHTML = "";
    phrases.forEach((phrase) => {
      const li = document.createElement("li");
      li.className = "phrases-item";
      li.dataset.id = phrase.id;
      const textSpan = document.createElement("span");
      textSpan.className = "phrases-item-text";
      textSpan.textContent = phrase.text;
      li.appendChild(textSpan);
      li.addEventListener("click", () => { if (!this.editingId) this._sendPhrase(phrase.text); });
      let longPressTimer;
      li.addEventListener("pointerdown", () => { longPressTimer = setTimeout(() => { this._enterEditMode(phrase.id); longPressTimer = null; }, 500); });
      li.addEventListener("pointerup", () => { if (longPressTimer) clearTimeout(longPressTimer); });
      li.addEventListener("pointerleave", () => { if (longPressTimer) clearTimeout(longPressTimer); });
      this.el.list.appendChild(li);
    });
  }

  _sendPhrase(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg = { type: "phrase", text, autoPaste: autoPasteEl.checked };
      if (windowSelector.targetWindow) msg.targetWindow = windowSelector.targetWindow;
      ws.send(JSON.stringify(msg));
      showToast("已发送常用语到电脑。");
    } else {
      showToast("发送失败，请检查连接。", true);
    }
  }

  _enterEditMode(editId) {
    this.editingId = editId;
    this.el.addBtn.classList.add("hidden");
    this.el.editDoneBtn.classList.remove("hidden");
    const items = this.el.list.querySelectorAll(".phrases-item");
    items.forEach((li) => {
      const id = li.dataset.id;
      const textSpan = li.querySelector(".phrases-item-text");
      const phrase = this._phrases.find((p) => p.id === id);
      if (!phrase) return;
      if (id === editId) {
        li.classList.add("editing");
        textSpan.classList.add("hidden");
        const input = document.createElement("textarea");
        input.className = "phrases-item-edit-input";
        input.rows = 2;
        input.value = phrase.text;
        li.insertBefore(input, textSpan.nextSibling);
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "phrases-item-delete";
        deleteBtn.type = "button";
        deleteBtn.textContent = "删除";
        deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); this._deletePhrase(id); });
        li.appendChild(deleteBtn);
      } else {
        li.style.opacity = "0.4";
        li.style.pointerEvents = "none";
      }
    });
  }

  _exitEditMode() {
    if (!this.editingId) return;
    this.editingId = null;
    this.el.addBtn.classList.remove("hidden");
    this.el.editDoneBtn.classList.add("hidden");
    this._saveEditChanges();
    this._render();
  }

  _saveEditChanges() {
    const editedInput = this.el.list.querySelector(".phrases-item.editing .phrases-item-edit-input");
    if (!editedInput) return;
    const editedId = editedInput.closest(".phrases-item").dataset.id;
    const newText = editedInput.value.trim();
    if (!newText) { this._deletePhrase(editedId); return; }
    const phrase = this._phrases.find((p) => p.id === editedId);
    if (phrase) { phrase.text = newText; this._phrases = this._phrases; }
  }

  _deletePhrase(id) { this._phrases = this._phrases.filter((p) => p.id !== id); this._render(); }

  _openAddDialog() { this.el.dialogInput.value = ""; this.el.dialog.classList.remove("hidden"); this.el.dialogInput.focus(); }
  _closeDialog() { this.el.dialog.classList.add("hidden"); }

  _confirmAdd() {
    const text = this.el.dialogInput.value.trim();
    if (!text) return;
    const phrases = this._phrases;
    phrases.unshift({ id: crypto.randomUUID(), text, createdAt: Date.now() });
    this._phrases = phrases;
    this._render();
    this._closeDialog();
  }

  addPhrase(text) {
    const exists = this._phrases.some((p) => p.text === text);
    if (exists) { showToast("该常用语已存在。"); return; }
    const phrases = this._phrases;
    phrases.unshift({ id: crypto.randomUUID(), text, createdAt: Date.now() });
    this._phrases = phrases;
    this._render();
    showToast("已收藏为常用语。");
  }

  showSaveButton() { this.el.saveBtn.classList.remove("hidden"); }
  hideSaveButton() { this.el.saveBtn.classList.add("hidden"); }
}

// === Initialize ===
const phrases = new PhrasesManager();
const windowSelector = new WindowSelector();
const recentCommands = new RecentCommands(document.querySelector("#recentBar"));

// === Text Input Events ===
textInput.addEventListener("input", () => {
  if (textInput.value.trim()) phrases.showSaveButton();
  else phrases.hideSaveButton();
});

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextInput(); }
});

// === Quick Bar (collapse) ===
const quickBar = document.querySelector("#quickBar");
const quickToggle = document.querySelector("#quickToggle");
const quickPanel = document.querySelector("#quickPanel");

quickToggle.addEventListener("click", () => {
  quickBar.classList.toggle("open");
  quickPanel.classList.toggle("hidden");
});

quickPanel.addEventListener("click", (e) => {
  const btn = e.target.closest(".quick-btn");
  if (!btn) return;
  const text = btn.dataset.text;
  if (!text) return;
  sendQuickCommand(text, btn.textContent.trim());
});

// Recent bar click
document.querySelector("#recentBar").addEventListener("click", (e) => {
  const tag = e.target.closest(".recent-tag");
  if (!tag) return;
  const text = tag.dataset.text;
  if (!text) return;
  sendQuickCommand(text, tag.textContent);
});

function sendQuickCommand(text, label) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg = { type: "phrase", text, autoPaste: autoPasteEl.checked };
    if (windowSelector.targetWindow) msg.targetWindow = windowSelector.targetWindow;
    ws.send(JSON.stringify(msg));
    recentCommands.record(text, label);
    showToast("已发送快捷指令。");
  } else {
    showToast("发送失败，请检查连接。", true);
  }
}

// === Action Buttons ===
enterButton.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "enter" }));
});

undoButton.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "undo" }));
});

phrases.el.saveBtn.addEventListener("click", () => {
  const text = textInput.value.trim();
  if (text) {
    phrases.addPhrase(text);
    phrases.el.saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> 已收藏 ✓';
    phrases.el.saveBtn.classList.add("saved");
  }
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
let isUploading = false;
let ws = null;

connectWebSocket();

function setActionButtonsDisabled(disabled) {
  enterButton.disabled = disabled;
  undoButton.disabled = disabled;
}

if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
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
  if (isRecording) stopRecording();
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

async function startRecording() {
  try {
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
    isRecording = true;
    recordSeconds = 0;
    recordButton.classList.add("recording");
    setRecordActive();
    setActionButtonsDisabled(true);
    setConnectionStatus(statusDot.className.includes("connected") ? "connected" : "connecting", "正在录音…");

    maxRecordTimer = setTimeout(() => { if (isRecording) { stopRecording(); showToast("已到 55 秒上限，正在上传音频..."); } }, 55_000);

    timerInterval = setInterval(() => {
      recordSeconds++;
      const mins = String(Math.floor(recordSeconds / 60)).padStart(2, "0");
      const secs = String(recordSeconds % 60).padStart(2, "0");
      labelEl.textContent = `${mins}:${secs}`;
    }, 1000);
  } catch (error) {
    showToast(`无法访问麦克风：${error.message}`, true);
  }
}

function stopRecording() {
  if (!isRecording || !recorder) return;
  isRecording = false;
  isUploading = true;
  clearTimeout(maxRecordTimer);
  clearInterval(timerInterval);
  recordButton.classList.remove("recording");
  recordButton.disabled = true;
  setRecordProcessing();
  showToast("正在上传音频...");
  recorder.stop();
}

async function uploadAudio(blob, extension) {
  try {
    if (!blob.size) { showToast("没有录到声音，请再试一次。", true); finishUpload(); return; }
    showToast("正在识别...");
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
    showToast(output.pasted ? "已复制并自动粘贴。" : "已复制到电脑剪切板。");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    finishUpload();
  }
}

function finishUpload() {
  isUploading = false;
  recordButton.disabled = false;
  setRecordIdle();
  setActionButtonsDisabled(false);
}

// === WebSocket ===
function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.addEventListener("open", () => setConnectionStatus("connected", "已连接电脑端"));
  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "result" && payload.text) {
        textInput.value = payload.text;
        phrases.showSaveButton();
        phrases.el.saveBtn.classList.remove("saved");
        phrases.el.saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> 收藏';
      }
      if (payload.message) {
        showToast(payload.message, payload.type === "error");
      }
      if (payload.type === "output" && payload.copied && !payload.pasted) {
        showToast(payload.pasteError ? "已复制，自动粘贴失败。" : "已复制到剪切板。", Boolean(payload.pasteError));
      }
    } catch {
      // Ignore malformed messages
    }
  });
  ws.addEventListener("close", () => {
    setConnectionStatus("error", "连接已断开，正在重连...");
    setTimeout(connectWebSocket, 1500);
  });
}

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function fileExtensionFor(mimeType) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg")) return "mp3";
  return "webm";
}
```

- [ ] **Step 2: 验证基础功能在浏览器中工作**

打开页面，检查：
- 状态圆点显示为灰色闪烁（连接中）
- 连接后圆点变绿
- 点击圆点显示 toast 提示
- 文本输入、发送、Enter 快捷键
- 折叠栏展开/收起

- [ ] **Step 3: 提交 JS 重写**

```bash
git add src/public/app.js
git commit -m "refactor(frontend): rewrite JS with toast, status dot, recent commands, toggle switch"
```

---

### Task 5: 验证所有功能并修复问题

**Files:**
- Modify: `src/public/index.html`, `src/public/style.css`, `src/public/app.js`（如有问题修复）

- [ ] **Step 1: 全面功能验证清单**

在浏览器中逐项检查：

1. [ ] 页面加载后紧凑布局，无需滚动
2. [ ] 连接状态圆点：灰色闪烁→绿色（连接后）→红色（断开后）
3. [ ] 点击状态圆点显示 toast
4. [ ] 窗口选择器正常弹出和选择
5. [ ] 快捷指令标签点击发送后，该指令出现在"最近指令"区
6. [ ] 最近指令最多显示 6 个
7. [ ] 文本输入框 Enter 发送，清空后收藏按钮消失
8. [ ] 录音按钮行内显示，点击录音，停止后上传识别
9. [ ] 录音中按钮变红+脉冲动画
10. [ ] 撤销/回车按钮正常工作
11. [ ] "更多指令"折叠栏展开/收起，内部指令可发送
12. [ ] "常用语"折叠栏展开/收起，点击发送，长按编辑/删除，新增
13. [ ] 自动粘贴 toggle 开关工作正常
14. [ ] 收藏按钮出现/消失正常
15. [ ] 暗色模式切换正常
16. [ ] 新增常用语弹窗正常弹出
17. [ ] 兜底上传按钮（不支持录音时）正常显示

- [ ] **Step 2: 修复发现的问题**

根据验证结果修复任何问题。

- [ ] **Step 3: 提交修复**

```bash
git add -A
git commit -m "fix(frontend): address issues found during full verification"
```

---

### Task 6: 最终审查和提交

**Files:**
- All frontend files

- [ ] **Step 1: 代码审查**

检查：
- 无 console.log 遗留
- 无未使用的 CSS 规则
- 无 JS 语法错误
- 所有 localStorage key 正确
- 所有元素 ID 与 JS 引用一致

- [ ] **Step 2: 确认 git log 干净**

```bash
git log --oneline -5
```

Expected: 看到本计划的各个提交。

- [ ] **Step 3: 最终确认后通知完成**
