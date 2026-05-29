# VoiceBridge 前端优化设计文档

日期：2026-05-30

## 概述

对 VoiceBridge 移动端 Web 应用的前端进行 7 项小到中等规模的优化，涵盖 PWA 支持、交互细节、代码健壮性和代码清理。所有改动相互独立，无风险变更。

## 1. PWA 基础支持

**目标**：让 VoiceBridge 可以"添加到主屏幕"后以全屏 App 模式运行。

**实现**：

- 复制用户提供的 `~/Desktop/VoiceBridge.png` 到 `src/public/icons/`
- 使用 `sips` 或 Node.js `sharp` 生成 192x192 和 512x512 尺寸的 PNG 图标
- 创建 `src/public/manifest.json`：
  - `name`: "VoiceBridge"
  - `short_name`: "VoiceBridge"
  - `start_url`: "/"
  - `display`: "standalone"
  - `background_color`: "#fffbf5"
  - `theme_color`: "#e8793a"
  - `icons`: 192x192 和 512x512 两个尺寸
- `index.html` 添加：
  - `<link rel="manifest" href="/manifest.json">`
  - `<meta name="theme-color" content="#e8793a">`
  - `<link rel="apple-touch-icon" href="/icons/icon-192.png">`
  - `<link rel="icon" type="image/png" href="/icons/icon-192.png">`

**不包含**：Service Worker（应用需要实时 WebSocket，离线缓存无意义）。

## 2. iOS 弹窗缩放修复

**问题**：新增指令 Bottom Sheet 的 textarea `font-size: 15px`，在 iOS Safari 聚焦时会触发页面缩放。

**修复**：将 `.add-cmd-sheet textarea` 的 `font-size` 从 `15px` 改为 `16px`。

**文件**：`src/public/style.css`

## 3. 暗色模式热切换

**问题**：当前暗色模式仅通过 `@media (prefers-color-scheme: dark)` 在 CSS 中实现。页面加载时确定主题后，运行中切换系统设置不会生效。

**方案**：当前的纯 `@media` 查询方式实际上**已经支持运行时切换**（浏览器自动响应）。需要先确认实际行为——如果确实不响应，则改为手动 dark class 方案：

- 在 `app.js` 中添加 `matchMedia('(prefers-color-scheme: dark)').addEventListener('change', callback)` 监听
- 动态在 `<html>` 上添加/移除 `dark` 类
- CSS 中的 `@media (prefers-color-scheme: dark)` 改为 `html.dark` 选择器

**文件**：`src/public/app.js`、`src/public/style.css`（仅在需要时改动）

## 4. 长按容差优化

**问题**：指令按钮长按编辑功能中，`pointermove` 事件会立即清除长按计时器。手指轻微滑动就取消长按，操作挫败感强。

**修复**：记录 `pointerdown` 的起始坐标，`pointermove` 时计算位移，仅在位移超过 `10px` 时才取消长按计时器。

**文件**：`src/public/app.js` — `CommandLibrary` 类中的长按事件处理

## 5. WebSocket 指数退避重连

**问题**：当前重连间隔固定 1.5 秒，网络长时间断开时会频繁重试。

**修复**：
- 初始间隔 1.5 秒
- 每次重连失败后间隔翻倍
- 上限 60 秒
- 连接成功后重置为初始值

**文件**：`src/public/app.js` — `connectWebSocket()` 函数

## 6. 窗口列表缓存

**问题**：每次打开窗口选择器下拉菜单都会发 `GET /api/windows` 请求，频繁操作有冗余网络开销。

**修复**：
- `_fetchWindows()` 成功后缓存结果
- 缓存有效期 5 秒
- 5 秒内再次调用直接返回缓存数据
- 超过 5 秒后下次打开重新请求

**文件**：`src/public/app.js` — `WindowSelector` 类

## 7. 清理未使用代码

**CSS 清理**（`src/public/style.css`）：
- 移除 `.terminal-btn` 及相关样式（约 35 行）
- 移除 `.save-btn` 非 sm 版本样式

**JS 清理**（`src/public/app.js`）：
- 移除 `_escHtml` 未使用方法
- 移除 `shortcutIcons` 未使用对象
- 排查并移除其他未引用的代码

## 改动范围

| 文件 | 改动类型 |
|------|---------|
| `src/public/icons/` | 新增目录，放入图标文件 |
| `src/public/manifest.json` | 新增文件 |
| `src/public/index.html` | 添加 meta/link 标签 |
| `src/public/style.css` | 修改 textarea font-size、移除未使用样式 |
| `src/public/app.js` | 长按容差、WebSocket 退避、窗口缓存、暗色模式监听、代码清理 |

## 不包含

- Service Worker / 离线缓存
- Bottom Sheet 拖拽关闭手势
- 全局键盘快捷键
- 认证/安全机制
