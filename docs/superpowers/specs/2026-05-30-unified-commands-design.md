# 统一指令库 设计文档

## 问题

VoiceBridge 目前有两套独立的指令系统：

1. **更多指令**：数据来自服务端静态文件 `commands.json`，不可在手机端增删编辑
2. **常用语（收藏）**：数据存在浏览器 localStorage，可增删编辑，但不跨设备同步

两套系统各自独立，UI 上通过 Tab 切换，数据结构不同，发送行为不一致。用户需要在两个面板之间切换，且无法对"更多指令"进行动态管理。

## 目标

将两套系统合并为一个**统一的指令库**，具备以下能力：

- 所有指令统一管理，支持分类、增删编辑
- 通过服务端 API 持久化，跨设备同步
- 收藏流程融入统一体系（选分类后收藏）
- 为后续产品化（Supabase 云数据库）预留迁移空间

## 数据存储方案

选择 B 方案：服务端 API + commands.json 文件。

**理由：**
- 当前是个人局域网工具，文件存储足够
- 不引入数据库依赖，保持轻量
- 后续迁移到 Supabase 时只需替换 API 层，前端不变

**数据文件：** `src/public/commands.json`（从静态资源改为 API 管理的读写文件）

**API 接口：**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/commands` | 返回全部指令 |
| POST | `/api/commands` | 新增一条指令 |
| PUT | `/api/commands/:id` | 更新一条指令（text/label/category） |
| DELETE | `/api/commands/:id` | 删除一条指令 |

## 数据结构

```json
{
  "commands": [
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "text": "先问是哪部分代码控制的这个功能，再改",
      "label": "问清再改",
      "category": "开发协作",
      "createdAt": 1748534400000,
      "lastUsedAt": 1748534400000
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | UUID，唯一标识 |
| text | string | 发送到电脑的实际文本 |
| label | string | 按钮上显示的名称 |
| category | string | 所属分类名 |
| createdAt | number | 创建时间戳（ms） |
| lastUsedAt | number | 最近使用时间戳（ms），用于排序 |

## 分类体系

**预设分类：**

| 分类 | 说明 |
|------|------|
| 开发协作 | 需求确认、计划概述、代码关联等与 AI 协作讨论的指令 |
| 工作流 | sub审查、系统巡检、实测改动等流程性指令 |
| 斜杠指令 | /clear、/compact、/git-commit 等以 / 开头的命令 |
| 终端 | npm start、copyclaw 等运维命令 |
| 通用 | 可、怎么用、记笔记等通用短语和原则 |

**扩展规则：**
- 用户新增指令时选择分类，也可输入新分类名自动创建
- 分类不需要独立的管理界面，随用随建
- 分类不预定义 ID，直接用分类名字符串匹配

**排序规则：**
- 分类间：按该分类内最近 `lastUsedAt` 排序，活跃分类浮到顶部
- 分类内：按 `lastUsedAt` 降序，最近使用的排前面
- 新增指令的 `lastUsedAt` 等于 `createdAt`

## UI 设计

### 整体布局

去掉现有的"更多指令"和"常用语"两个 Tab，替换为一个统一的"指令库"面板。

```
┌─────────────────────────────┐
│  指令库    [搜索] [+ 新增]   │
├─────────────────────────────┤
│  [搜索栏 - 关键词过滤]        │
├─────────────────────────────┤
│  ▾ 开发协作          (6)      │
│    [问清再改] [需求确认] ...  │
│  ▾ 工作流            (7)      │
│    [sub审查] [系统巡检] ...   │
│  ▾ 斜杠指令          (5)      │
│    [/clear] [/compact] ...   │
│  ▾ 终端              (2)      │
│    [npm start] [copyclaw]    │
│  ▾ 通用              (7)      │
│    [可] [怎么用] ...          │
└─────────────────────────────┘
```

### 关键交互

**搜索：** 顶部搜索按钮点击后展开搜索栏，输入关键词实时过滤指令（跨分类匹配）。

**分类折叠：** 点击分类标题行可折叠/展开该分类下的指令。默认全部展开。

**指令发送：** 单击指令按钮 → `sendQuickCommand(text, label)`，同时更新 `lastUsedAt` 并重新排序。

**编辑模式（长按触发）：**
1. 长按指令按钮 500ms 进入编辑模式
2. 被编辑的指令变为可编辑状态（contenteditable）
3. 其余指令变暗，禁止交互
4. 出现"删除"按钮和"完成"按钮
5. 点击"完成"保存修改，清空编辑状态

**新增指令（+ 新增按钮 / 收藏按钮共用弹窗）：**
底部弹出表单，包含：
- 文本输入框（收藏时自动带入输入框内容，可编辑）
- 分类下拉选择器（已有分类列表 + "+ 新建分类"选项）
- 取消 / 保存按钮

### 视觉风格

- 继续沿用暗色暖橙主题（现有 dopamine 风格）
- 斜杠指令 / 终端指令用 monospace 字体 + 橙色底色区分
- 分类标题用小号大写字母 + 计数 badge
- 按钮使用流式横向排列，自适应换行

## 前端改动

### 删除

- `PhrasesManager` 类（app.js 第 298-448 行）
- Tab 切换逻辑（app.js 第 467-485 行）
- 常用语相关 HTML 元素（index.html 中的 phrasesPanel 等）
- 常用语相关 CSS（style.css 中的 `.phrases-*` 样式）
- Tab 导航 HTML/CSS（`tab-bar`、`tab-btn` 等）

### 新增

- `CommandLibrary` 类：替代 PhrasesManager，负责指令的 API 读写、渲染、排序、编辑
- 指令库面板 HTML（标题栏 + 搜索 + 分类列表容器）
- 收藏/新增弹窗 HTML
- 指令库相关 CSS

### 修改

- `loadCommands()` 函数：从 fetch 静态文件改为调用 `GET /api/commands`
- 收藏按钮点击逻辑：从直接存 localStorage 改为弹出新增弹窗
- `sendQuickCommand()`：调用后额外发送 PUT 请求更新 `lastUsedAt`

## 服务端改动

### 新增

- `/api/commands` 路由（CRUD）：
  - GET：读取 commands.json，返回指令列表
  - POST：追加指令到 commands.json，写入文件
  - PUT /:id：查找并更新指令字段，写入文件
  - DELETE /:id：过滤删除指定指令，写入文件

### 修改

- commands.json 格式迁移（从 `{ terminal: [], shortcuts: [], quick: [] }` 迁移为 `{ commands: [] }`）
- 首次启动时自动迁移旧格式到新格式（兼容处理）

## 不涉及的改动

- WebSocket 通信协议不变
- `sendQuickCommand()` 的核心发送逻辑不变
- `copyToPhoneClipboard()` 不变
- `RecentCommands` 不变
- 电脑端剪切板逻辑不变
- 不引入数据库（后续产品化时再迁移）

## 迁移策略

首次启动时，服务端检测 commands.json 格式：
- 如果是旧格式（包含 `terminal`/`shortcuts`/`quick` 字段），自动合并为新的 `{ commands: [] }` 格式
- 为每条旧指令分配 UUID、分类、时间戳
- 旧格式中 `shortcuts` 归入"斜杠指令"分类，`terminal` 归入"终端"分类，`quick` 根据内容智能归类或归入"通用"

localStorage 中已有的常用语（voicebridge_phrases）在首次加载 API 数据后提示用户是否迁移（或自动合并到"通用"分类下）。
