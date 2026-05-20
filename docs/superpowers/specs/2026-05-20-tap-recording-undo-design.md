# 录音点击切换 + 撤销按钮 设计文档

日期：2026-05-20

## 背景

当前 VoiceBridge 录音按钮采用长按交互（pointerdown 开始 / pointerup 结束），用户希望改为点击切换（点击开始、再次点击停止），同时新增撤销按钮以模拟 Cmd+Z 撤销最近一次粘贴。

## 变更范围

仅涉及前端交互和 WebSocket 消息处理，不改动 ASR 识别、音频转换、剪贴板写入等核心流程。

## 设计决策

| 项目 | 决策 |
|------|------|
| 录音交互 | 长按 → 点击切换（click 事件） |
| 录音按钮图标 | 线性 SVG（Apple SF Symbols 风格）：空闲=麦克风，录音中=方块 |
| 录音中计时器 | 实时显示已录时长（MM:SS 格式） |
| 录音中动画 | 图标外圈脉冲动画 |
| 撤销行为 | 模拟 Cmd+Z（macOS），通过 osascript 执行 |
| 操作栏布局 | 撤销（左）+ 回车（右），录音中两个按钮置灰禁用 |
| 标题文案 | 「按住说话」→「语音输入」 |

## 前端变更

### 1. 录音按钮交互（app.js）

将事件监听从 Pointer Events 改为 click 事件：

**删除**：
- `pointerdown` / `pointerup` / `pointerleave` 事件监听
- `isStarting` / `stopRequested` 竞态处理逻辑（click 模式下不需要）

**新增**：
- `click` 事件监听，根据 `isRecording` 状态切换 start/stop
- 录音计时器 `setInterval`，每秒更新显示（MM:SS）
- 停止录音时清除计时器

**按钮文案与图标切换**：
- 空闲态：麦克风 SVG 图标 + "点击录音" + "再次点击停止并发送"
- 录音态：方块 SVG 图标 + 计时器 + "停止录音" + "点击结束并发送"
- 上传处理态：按钮 disabled，显示"处理中…"

### 2. 撤销按钮（app.js + index.html）

**新增 HTML**：在 enterButton 前方插入 undoButton
```
<button id="undoButton" class="undo-button" type="button">↩ 撤销</button>
```

**新增 JS**：
```javascript
undoButton.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "undo" }));
  }
});
```

**禁用逻辑**：录音中和上传处理中，undoButton 与 enterButton 均置灰禁用。

### 3. 操作栏布局（index.html + style.css）

将回车按钮和撤销按钮放在同一行 flex 容器中，各占 50%：

```html
<div class="action-row">
  <button id="undoButton" class="action-button undo-button">↩ 撤销</button>
  <button id="enterButton" class="action-button enter-button">↵ 回车</button>
</div>
```

样式：两个按钮等宽、等高，圆角 12px，撤销用石板灰 `#78716c`，回车用深灰蓝 `#475569`。

### 4. 标题文案（index.html）

`<h1>` 内容从"按住说话"改为"语音输入"。

### 5. 按钮文案更新（app.js 中的 status 文案）

所有状态提示中"按住"/"松开"相关措辞改为"点击"：
- 空闲 → "点击开始录音"
- 录音中 → "正在录音…"
- 上传中 → "正在上传…"

## 服务端变更

### 1. WebSocket 处理（ws.js）

新增 `undo` 消息类型处理：

```javascript
if (payload.type === "undo") {
  await pressUndo();
}
```

### 2. 撤销按键模拟（paste.js）

新增 `pressUndo()` 函数，macOS 实现：

```javascript
async function pressUndo() {
  const script = 'tell application "System Events" to keystroke "z" using {command down}';
  await execAsync(`osascript -e '${script}'`);
}
```

导出 `pressUndo` 供 ws.js 调用。

## 不变的部分

- 自动粘贴开关及其逻辑
- 识别结果展示区
- WebSocket 连接/重连机制
- ASR 识别流程
- 音频上传和处理流程
- 兜底文件上传按钮
- 55 秒录音上限

## 文件变更清单

| 文件 | 变更类型 |
|------|----------|
| `src/public/index.html` | 修改：标题文案、新增撤销按钮、操作栏布局重构 |
| `src/public/style.css` | 修改：新增操作栏 flex 容器样式、撤销按钮样式、录音按钮图标区域、脉冲动画、计时器样式 |
| `src/public/app.js` | 修改：录音事件改为 click、新增计时器、新增撤销按钮事件、按钮状态切换逻辑 |
| `src/server/ws.js` | 修改：新增 undo 消息处理 |
| `src/server/input/paste.js` | 修改：新增 pressUndo() 函数并导出 |
