# Saved Phrases Feature Design

## Overview

为 VoiceBridge 移动端添加"常用语"收藏功能。用户可以保存常用文字，一键发送到电脑端，避免重复语音输入。

## Requirements

- 用户能从语音识别结果快速收藏文字为常用语
- 用户能手动新增、编辑、删除常用语
- 点击常用语直接发送到电脑端（写剪切板 + 可选自动粘贴）
- 数据存储在手机端 localStorage，无需服务端持久化

## UI Design

### 入口：底部抽屉

录音区域下方有一个可折叠抽屉。收起时显示为提示条 "▲ 常用语 (N)"，点击展开后显示常用语列表。

### 交互模式

| 操作 | 行为 |
|------|------|
| 点击提示条 | 展开/收起抽屉 |
| 点击某条常用语 | 直接发送到电脑端 |
| 点击 "+ 新增" | 弹出输入框，手动添加常用语 |
| 长按某条常用语 | 进入编辑模式，该条变为 input 可编辑 |
| 编辑模式中点击 "删除" | 删除该条常用语 |
| 编辑模式中点击 "完成" | 退出编辑模式，保存所有修改 |
| 识别结果出现时 | 结果区下方显示 "⭐ 收藏为常用语" 按钮 |
| 点击 "收藏为常用语" | 将当前识别文字保存为常用语，按钮变为 "已收藏 ✓" |

### 状态流转

```
收起 → 展开（点击提示条）
展开 → 收起（点击"收起"或点击常用语发送后）
正常 → 编辑（长按某条）
编辑 → 正常（点击"完成"）
```

## Data Model

### localStorage key: `voicebridge_phrases`

```json
[
  {
    "id": "uuid-string",
    "text": "常用语文字内容",
    "createdAt": 1747700000000
  }
]
```

- `id`：使用 `crypto.randomUUID()` 生成
- 按创建时间倒序排列（最新的在前）
- 不设条目数量上限

## Architecture

### 前端（app.js）

新增一个 `PhrasesManager` 模块，负责：
- CRUD 操作 localStorage 中的常用语数据
- 渲染抽屉列表 DOM
- 处理长按进入编辑模式
- 管理抽屉展开/收起状态

### 服务端（ws.js）

WebSocket 新增消息类型：

```json
{ "type": "phrase", "text": "要发送的文字", "autoPaste": true }
```

收到 `phrase` 消息后，复用现有 `outputText(text, { autoPaste })` 逻辑，写剪切板并可选自动粘贴。与 `enter`/`undo` 消息处理模式一致。

### 文件变更

| 文件 | 变更 |
|------|------|
| `src/public/index.html` | 添加抽屉 DOM 结构、收藏按钮、新增弹窗 |
| `src/public/app.js` | 添加 PhrasesManager 模块、WebSocket phrase 消息处理 |
| `src/public/style.css` | 添加抽屉样式、编辑模式样式、收藏按钮样式 |
| `src/server/ws.js` | 添加 `phrase` 消息类型处理，调用 outputText |

### 不变的文件

- `src/server/routes/upload.js` — 不变，识别流程不受影响
- `src/server/input/` — 不变，outputText 直接复用
- `src/server/config.js` — 不变

## Error Handling

- localStorage 写入失败：toast 提示"保存失败"
- 常用语发送失败（WebSocket 断开）：toast 提示"发送失败，请检查连接"
- 空文字不允许保存：新增时 trim 校验
