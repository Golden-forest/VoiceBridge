# VoiceBridge 官网落地页设计文档

**日期：** 2026-08-01
**分支：** cloud-activation
**版本：** v0.1.0 内测期
**状态：** 待用户审阅

---

## 1. 目标与范围

### 1.1 目标

为 VoiceBridge 项目设计一个独立的官网落地页（Landing Page），用于：

1. **第一印象承载**：新用户从 GitHub README、Product Hunt、社群传播等渠道进入，第一眼建立"大厂感"和"工具温度感"
2. **桌面端下载转化**：核心 CTA 是下载 macOS / Windows 桌面端 Agent
3. **核心卖点传达**：突出"跨设备语音输入"和"快捷指令封装"两个差异化能力

### 1.2 范围（In Scope）

- 落地页完整 HTML / CSS / JS 实现
- 6 个核心 section 的视觉与交互
- 桌面端 + 移动端响应式适配
- 路由调整：`/` → 落地页，`/app` → 原 PWA 应用

### 1.3 不在本次范围（Out of Scope）

- 定价 section（v0.1.0 内测免费，未来加 Pro 再说）
- 独立 FAQ section（直接复用现有 `/faq.html`）
- A/B 测试框架
- 多语言（先做中文，未来扩展）
- 营销像素 / 数据埋点（可作为后续 PR）

---

## 2. 核心设计决策（用户已确认）

| # | 决策项 | 选定方案 | 理由 |
|---|---|---|---|
| 1 | **路由位置** | B-变种：根路径 `/` 变落地页，`/app` 移动到原 PWA | 与 Supabase / OpenAI 大厂结构一致；首访客远多于回访 |
| 2 | **整体视觉方向** | B：暗色橙辉光（Hero 区） | 暖橙在暗色背景里像火焰，冲击力最强 |
| 3 | **Hero 核心动效** | C 主推 + B 辅助：打字机 + 背景微弱粒子流 | "动效即叙事"——打字机本身就是产品演示 |
| 4 | **Hero 文案** | 1+3 混合：静态大字"说，即是写" + 打字机副标题 | 品牌张力 + 产品功能双承载 |
| 5 | **页面骨架** | B 优化版（6 段）+ 快捷指令专区 | 大厂标配叙事节奏 |
| 6 | **快捷指令可视化** | C + A 双 section 串联 | 上半身场景化叙事 + 下半身清单展示 |
| 7 | **下载区** | 三平台横排卡片 + GitHub Releases 302 重定向 | 直接触发下载，无中间页 |
| 8 | **技术实现** | 3 文件方案（landing.html/css/js） | 可维护性 |
| 9 | **FAQ** | 不做独立 section，页脚链接到现有 `/faq.html` | 内测期问题量少 |
| 10 | **移动端** | 响应式优先移动端，简化版对比图 | 移动端冲击力保留 |

---

## 3. 视觉规范

### 3.1 设计 Token（直接复用 PWA `style.css` `:root`）

**通过 `<link rel="stylesheet" href="/style.css">` 直接复用**，不重新定义。

| Token | 值 | 用途 |
|---|---|---|
| `--accent` | `#e8793a` | 主色：CTA、链接、图标 |
| `--accent-deep` | `#c2410c` | 深色：hover、标题 |
| `--accent-gradient` | `linear-gradient(135deg, #f97316, #ea580c)` | 主渐变：CTA、品牌字 |
| `--accent-glow` | `rgba(232, 121, 58, 0.35)` | 辉光 |
| `--bg-page` | `#fffbf5` | 浅色 section 背景（基色） |
| `--text-primary` | `#1c1917` | 主文字 |
| `--text-secondary` | `#78716c` | 次文字 |
| `--shadow-card` | `0 2px 12px rgba(200, 120, 50, 0.08), 0 1px 3px rgba(0, 0, 0, 0.04)` | 卡片 |
| `--shadow-accent-lg` | `0 4px 16px rgba(232, 121, 58, 0.35)` | 主色按钮辉光 |
| `--radius-lg` | `22px` | 大卡片 |
| `--radius-xl` | `28px` | 超大容器 |
| `--ease-bounce` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 弹性回弹 |
| `--ease-smooth` | `cubic-bezier(0.4, 0, 0.2, 1)` | 平滑过渡 |

### 3.2 落地页专属 Token（在 `landing.css` 中定义）

```css
:root {
  /* === Hero 暗色专属 === */
  --hero-bg: radial-gradient(ellipse at top right,
              #2a1810 0%, #1a1310 60%, #0d0a08 100%);
  --hero-text: #f4f1ed;
  --hero-sub: #c1bdb7;
  --hero-accent: #f97316;
  --hero-accent-soft: #fdba74;
  --hero-glow-1: rgba(234, 88, 12, 0.4);   /* 顶部右辉光 */
  --hero-glow-2: rgba(249, 115, 22, 0.3);  /* 底部左辉光 */

  /* === 打字机 === */
  --cursor-color: #f97316;
  --cursor-width: 3px;
  --type-speed: 65ms;     /* 单字打出间隔 */
  --type-pause: 1800ms;   /* 打完后停留 */
  --type-clear-speed: 25ms; /* 清空速度 */

  /* === 粒子流 === */
  --particle-color: #f97316;
  --particle-glow: 0 0 8px #f97316, 0 0 16px rgba(249, 115, 22, 0.5);
  --particle-opacity: 0.45;  /* 关键：保持微弱，不抢打字机戏 */
}
```

### 3.3 字体（直接复用 PWA）

```html
<!-- 复用 PWA 已加载的本地 woff2 字体，无需重新引入 -->
<!-- 来自 hosted-pwa/public/fonts/Nunito-Variable.woff2 和 JetBrainsMono-Variable.woff2 -->
```

字体栈：
- 正文：`"SF Pro Rounded", "Nunito", -apple-system, sans-serif`
- 代码：`"JetBrains Mono", "SF Mono", Menlo, monospace`

### 3.4 字号层级（桌面端）

| 层级 | 字号 | 权重 | 字距 | 用途 |
|---|---|---|---|---|
| Hero 超大字 | `clamp(56px, 8vw, 96px)` | 800 | `-0.04em` | "说，即是写。" |
| Hero 副标题 | `clamp(16px, 2vw, 22px)` | 500 | 0 | 打字机内容 |
| Section 标题 | `clamp(32px, 5vw, 48px)` | 800 | `-0.025em` | 每个 section 主标题 |
| Section 副标题 | `clamp(15px, 1.8vw, 18px)` | 400 | 0 | section 描述 |
| 卡片标题 | `18px` | 800 | `-0.01em` | 功能卡 / 指令卡 |
| 卡片正文 | `14px` | 400 | 0 | 描述文字 |
| 小字 | `12px` | 600 | 0 | 平台说明、版本号 |
| Eyebrow | `11px` | 800 | `0.18em` | section 上方小标签 |

### 3.5 圆角与按钮

- 卡片：`var(--radius-lg)` = 22px
- 按钮：`999px`（胶囊形，与 PWA 一致）
- 主 CTA：`var(--accent-gradient)` 背景 + `var(--shadow-accent-lg)` 辉光
- 次 CTA：白色背景 + `1px solid var(--border)` + `var(--shadow-button)`

### 3.6 动效规范

- **打字机**：使用 `setTimeout` 链式调用，不使用 `requestAnimationFrame`（避免复杂度）
- **粒子流**：纯 CSS `@keyframes flow` + `animation-delay` 错峰
- **滚动锚点**：`scroll-behavior: smooth` + `scroll-margin-top: 80px`（避开 sticky 导航）
- **hover 反馈**：`transition: all 0.2s var(--ease-bounce)`（与 PWA 一致）
- **无障碍**：`@media (prefers-reduced-motion: reduce)` 关闭所有动画

---

## 4. 页面结构（最终骨架）

```
┌────────────────────────────────────────────┐
│ NAV（sticky, 暗色半透明 + blur）             │
│  VoiceBridge logo  ·  功能 · 下载 · GitHub │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ SECTION 1: HERO（暗色，100vh）              │
│  - 超大静态字："说，即是写。"                │
│  - 打字机副标题（白色逐字打出）              │
│  - CTA: 下载桌面端 ↓                       │
│  - 背景粒子流（手机→电脑，opacity 0.45）    │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ SECTION 2: 功能卡 ×3（浅色，~60vh）         │
│  🎤 按住说话    📋 自动粘贴    💻 多平台    │
│  (3 列卡片，hover 上浮 + 橙色边框)          │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ SECTION 3: 快捷指令专区（浅色，~140vh）     │
│                                            │
│  3A 场景叙事（上半身）：                    │
│    📱 手机说"周报模板"  →  💻 文档出现     │
│    标题：手机说一句话，电脑文档里出现整段   │
│                                            │
│  3B 指令卡片网格（下半身，8-12 卡）：       │
│    📋 📝 💬 📧                             │
│    🔧 📌 🎯 ➕                             │
│    (直接复用 PWA .cmd-btn 样式)             │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ SECTION 4: 3 步使用流程（浅色，~50vh）      │
│  ① 注册登录  →  ② 安装桌面端  →  ③ 录音粘贴 │
│  (横向 timeline + 连接线)                   │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ SECTION 5: 下载区（暖橙调，~70vh）          │
│  ┌─────────┬─────────┬─────────┐          │
│  │ macOS   │ macOS   │ Windows │          │
│  │ ARM64   │ x64     │ x64     │          │
│  │ [下载]   │ [下载]   │ [下载]  │          │
│  └─────────┴─────────┴─────────┘          │
│  v0.1.0 · 内测免费 · 需配合 PWA             │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ FOOTER（暗色，~20vh）                       │
│  PWA 入口 · GitHub · 隐私 · 条款 · FAQ      │
│  © 2026 VoiceBridge                        │
└────────────────────────────────────────────┘
```

**总高度约 440vh**（桌面端），移动端因单列堆叠会到 ~620vh。

---

## 5. 各 Section 详细设计

### 5.1 NAV（sticky 导航）

**位置：** fixed top，高 64px，z-index 1000

**视觉：**
- 默认（在 Hero 区）：背景 `rgba(13, 10, 8, 0.6)` + `backdrop-filter: blur(12px)`
- 滚动出 Hero 后：背景 `rgba(255, 251, 245, 0.85)` + `backdrop-filter: blur(12px)` + 底部 `1px solid var(--border)`
- 切换通过 `IntersectionObserver` 监听 Hero section

**内容（左到右）：**
- 左：`icon-192.png`（24px）+ "VoiceBridge" 文字（800 权重）
- 中：锚点链接 `功能` `快捷指令` `使用流程` `下载`（smooth scroll）
- 右：`GitHub` 外链 + `打开应用 →` 链接到 `/app`

**移动端：** 隐藏中间锚点，只保留 logo + 右上汉堡菜单（点击展开竖向菜单）

### 5.2 SECTION 1: HERO

**容器：**
- `min-height: 100vh`
- `background: var(--hero-bg)`
- `position: relative; overflow: hidden`
- 内容居中对齐

**装饰元素（绝对定位）：**
- 辉光球 1：`width: 480px; height: 480px; background: var(--hero-glow-1); filter: blur(80px); top: -120px; right: -100px;`
- 辉光球 2：`width: 360px; height: 360px; background: var(--hero-glow-2); filter: blur(70px); bottom: -100px; left: -80px;`
- 粒子流层：占满宽度，`pointer-events: none; opacity: var(--particle-opacity);`，包含 6-8 个 `<div class="particle">`，CSS keyframes 驱动从左下到右上流动

**核心内容（z-index: 2）：**

```html
<div class="hero-content">
  <span class="hero-eyebrow">VOICE-TO-KEYBOARD BRIDGE</span>

  <h1 class="hero-title">
    说，<span class="accent">即是写</span>。
  </h1>

  <div class="hero-subtitle">
    <span id="typewriter"></span><span class="cursor"></span>
  </div>

  <div class="hero-cta-group">
    <a href="#download" class="btn-primary">下载桌面端 ↓</a>
    <a href="/app" class="btn-secondary">打开网页版 →</a>
  </div>
  <!-- 注意：网页版按钮指向 PWA 应用入口 /app，让"暂不想下载"的用户也能立刻试用产品。
       主 CTA（下载）视觉权重最高，次 CTA（网页版）次之，避免分散注意力。 -->

  <p class="hero-meta">
    macOS Apple Silicon / Intel · Windows 64 位<br>
    免费内测 · 无需信用卡
  </p>
</div>
```

**打字机文案（轮播，每条打完停留 1.8s 后清空重打下一条）：**

```javascript
const TYPEWRITER_LINES = [
  "手机说话 → 文字自动出现在电脑光标处。",
  "按住手机录音，松开即转写，无需切换窗口。",
  "把常用长文本封装成指令，说一句话就触发。",
];
```

- 字间距：65ms / 字
- 停留时长：1800ms
- 清空：25ms / 字（倒序删除）
- 循环：3 条轮流，无限循环
- 光标：3px 宽 / 1.1em 高，闪烁周期 900ms，`steps(1)` 模式

**Hero 大字"说，即是写"静态渲染：**
- "说，"和"。"用 `var(--hero-text)` 即 `#f4f1ed`
- "即是写"用 `background: var(--accent-gradient); -webkit-background-clip: text; color: transparent;`

**CTA 按钮：**
- 主按钮 `.btn-primary`：
  - `padding: 14px 32px;`
  - `background: var(--accent-gradient);`
  - `color: #fff;`
  - `border-radius: 999px;`
  - `box-shadow: var(--shadow-accent-lg);`
  - hover：`transform: translateY(-2px); box-shadow: 0 8px 24px rgba(232, 121, 58, 0.5);`
- 次按钮 `.btn-secondary`：
  - `background: rgba(255,255,255,0.08);`
  - `color: var(--hero-text);`
  - `border: 1px solid rgba(255,255,255,0.15);`
  - hover：`background: rgba(255,255,255,0.12);`

### 5.3 SECTION 2: 功能卡 ×3

**容器：**
- `padding: 96px 24px;`
- `background: linear-gradient(165deg, #fffbf5 0%, #fff5eb 40%, #fef7f0 100%);`

**标题区：**
- Eyebrow: `FEATURES`
- 主标题：`三个能力，让你的输入速度 ×3。`
- 副标题：`语音转写、自动粘贴、快捷指令，组合起来就是效率飞跃。`

**卡片网格（3 列，gap 24px，max-width 1200px）：**

每张卡片：
- `background: #fff;`
- `border: 1px solid rgba(255,255,255,0.8);`
- `border-radius: var(--radius-lg);`
- `padding: 32px 28px;`
- `box-shadow: var(--shadow-card);`
- hover：`transform: translateY(-4px); box-shadow: 0 8px 24px rgba(200, 120, 50, 0.12);`
- transition：`all 0.25s var(--ease-bounce);`

**卡片内容：**

| 卡片 | 图标 | 标题 | 描述 |
|---|---|---|---|
| 1 | 🎤 | 按住说话 | 手机端按住录音按钮，松开即转写。无需打开特定应用，系统任何输入框都能接收。 |
| 2 | 📋 | 自动粘贴 | 文字直接出现在电脑光标位置，无需切换窗口、无需复制粘贴。 |
| 3 | 💻 | 全平台桌面端 | macOS Apple Silicon / Intel / Windows 64 位全覆盖，本地运行，低延迟。 |

**图标：** 用 SVG 内联（统一线宽 2px，主色 `#e8793a`，48×48px）。emoji 仅作为 fallback，不推荐主用。

### 5.4 SECTION 3: 快捷指令专区（重点）

**容器：**
- `padding: 96px 24px 120px;`
- `background: linear-gradient(180deg, #fef7f0 0%, #fff5eb 100%);`
- 通过 `scroll-margin-top: 80px` 确保 sticky nav 不遮挡

#### 5.4A 上半身：手机+电脑对比场景

**布局：** `display: grid; grid-template-columns: 1fr auto 1fr; gap: 32px;`

**左侧手机 mockup：**
- 外框：`background: #1c1917; border-radius: 28px; padding: 12px;`
- 尺寸：`width: 240px; height: 380px;`
- 屏幕：`background: linear-gradient(165deg, #fffbf5, #fff5eb); border-radius: 20px;`
- 内容：
  - 顶部 mic 按钮（橙色渐变圆形，40×40px，带 pulse 动画）
  - 用户语音气泡（白底 + 阴影）："你说 → \"周报模板\""
  - 底部小字："已触发预设指令"

**中间箭头：**
- 文字 `→`
- 字号 `48px`，颜色 `var(--accent)`
- 下方小字："一句话"

**右侧文档窗口 mockup：**
- 外框：`background: #fff; border: 2px solid #e5e5e5; border-bottom: 8px solid #d4d4d4; border-radius: 12px 12px 4px 4px;`
- 尺寸：`min-height: 280px;`
- 内容：
  - 顶部三个 macOS 红黄绿圆点
  - 标题栏：`周报.md`
  - 文档主体：
    ```
    # 本周工作
                    ← 这里"自动出现"以下内容
                    ← 每行打字机效果逐字打出
                    ← 末尾光标闪烁
                    · 完成 VoiceBridge 官网设计
                    · 修复 PWA 双端同步 bug
                    · 上线 v0.1.0 内测版本

                    # 下周计划
                    · 启动 Product Hunt 发布
                    · 收集首批用户反馈|
                    ```
- 右侧文档也有独立的打字机效果（与 Hero 共用 `landing.js` 中的 `Typewriter` 类）

**标题（grid 上方）：**
- Eyebrow: `PRESET COMMANDS`
- 主标题：`手机说一句话，<br>电脑文档里出现整段模板。`
- 副标题：`不再手打重复的长文本。把任何模板封装成快捷指令，下次只需要说一句话。`

#### 5.4B 下半身：指令卡片网格

**布局：** `display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; max-width: 720px;`

**卡片样式（直接复用 PWA `.cmd-btn`）：**

> 圆角决策：使用 `14px` 方形圆角（与功能卡视觉对齐），不使用 999px 胶囊形（胶囊形会让 8 张卡片网格显得过于"按钮化"，弱化"指令清单"的语义）。

```css
.preset-card {
  background: var(--bg-card);
  border: none;
  border-radius: var(--radius-sm);  /* 14px 方形 */
  padding: 16px 12px;
  box-shadow: var(--shadow-card);
  transition: all 0.2s var(--ease-bounce);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  min-height: 92px;
}
.preset-card:hover {
  transform: scale(1.05);
  background: var(--accent);
  color: var(--accent-text);
  box-shadow: var(--shadow-accent-lg);
}
```

**预设指令清单（8 张卡片）：**

| # | 图标 | 名称 | 隐含触发文本 |
|---|---|---|---|
| 1 | 📋 | 周报 | 周报模板 |
| 2 | 📝 | 会议纪要 | 会议纪要模板 |
| 3 | 💬 | 客服话术 | 标准客服回复 |
| 4 | 📧 | 邮件模板 | 标准邮件格式 |
| 5 | 🔧 | 代码片段 | 常用代码模板 |
| 6 | 📌 | 项目状态 | 项目状态更新模板 |
| 7 | 🎯 | OKR 对齐 | OKR 模板 |
| 8 | ➕ | 自定义 | （hover 提示："创建你自己的指令"） |

**卡片下方说明：**
- 文字："内置 11 条预设 + 无限自定义 · 与 PWA 同步"

### 5.5 SECTION 4: 3 步使用流程

**容器：**
- `padding: 96px 24px;`
- `background: linear-gradient(165deg, #fffbf5 0%, #fff5eb 100%);`

**标题：**
- Eyebrow: `HOW IT WORKS`
- 主标题：`三步开始用。`
- 副标题：`从下载到第一次语音输入，不到 2 分钟。`

**Timeline（横向，3 列 + 连接线）：**

布局：`display: grid; grid-template-columns: 1fr 1fr 1fr; position: relative;`

每步：
- 顶部：大号步骤数字（`clamp(48px, 6vw, 72px)`，800 权重，`color: var(--accent)`）
- 中部：步骤标题 + 描述
- 底部：mini 截图占位（120×80px，浅色背景 + icon）

| 步骤 | 标题 | 描述 |
|---|---|---|
| ① | 手机打开 PWA | 访问 `voicebridge-6kr.pages.dev/app`，注册账号登录。添加到主屏幕即可像原生 App 使用。 |
| ② | 电脑安装桌面端 | 下载对应平台的 Agent，登录同一账号，自动建立连接。 |
| ③ | 录音 → 自动粘贴 | 手机按住说话，松开瞬间文字出现在电脑光标处。完成。 |

**连接线：** 步骤之间的水平虚线 `border-top: 2px dashed rgba(232, 121, 58, 0.3);`，定位 `top: 60px;`

### 5.6 SECTION 5: 下载区

**容器：**
- `id="download"`
- `scroll-margin-top: 80px;`
- `padding: 96px 24px;`
- `background: linear-gradient(135deg, #fff5eb 0%, #fef0e0 100%);`

**标题：**
- Eyebrow: `DOWNLOAD`
- 主标题：`立即下载，开始用。`
- 副标题：`免费内测，无需信用卡。配合手机端 PWA 使用。`

**下载卡片网格（3 列）：**

每张卡片：
- `background: #fff;`
- `border: 1px solid var(--border);`
- `border-radius: var(--radius-lg);`
- `padding: 32px 24px;`
- `box-shadow: var(--shadow-card);`
- text-align: center
- hover：`transform: translateY(-4px); box-shadow: 0 8px 24px rgba(200, 120, 50, 0.15);`

**卡片内容：**

| 平台 | 图标 | 标题 | 子标题 | 下载链接 |
|---|---|---|---|---|
| macOS Apple Silicon | 🍎 | macOS | Apple Silicon (M1/M2/M3/M4) | `https://github.com/{owner}/{repo}/releases/download/v0.1.0/VoiceBridge-Agent-darwin-arm64-0.1.0.zip` |
| macOS Intel | 🍎 | macOS | Intel | `https://github.com/{owner}/{repo}/releases/download/v0.1.0/VoiceBridge-Agent-darwin-x64-0.1.0.zip` |
| Windows 64 位 | 🪟 | Windows | 64 位 | `https://github.com/{owner}/{repo}/releases/download/v0.1.0/VoiceBridge-Agent-win32-x64-0.1.0.zip` |

**下载按钮：**
- `display: inline-block;`
- `padding: 12px 28px;`
- `background: var(--accent-gradient);`
- `color: #fff;`
- `border-radius: 999px;`
- `box-shadow: var(--shadow-accent);`
- `font-weight: 800;`
- `target="_blank"` + `rel="noopener"` （GitHub Releases 的 asset URL 会自动 302 重定向到 CDN 下载）

**卡片底部小字：**
- 文件大小（如 `~12 MB`，需在 release 上传后填实际值）
- 系统要求（如 `macOS 12+`）

**下载区底部：**
- 文字：`v0.1.0 内测版 · 需要 iPhone / Android 配合 PWA 使用`
- 链接：`打开 PWA 网页版 →`（指向 `/app`）

### 5.7 FOOTER

**容器：**
- `background: #1c1917;`
- `color: #c1bdb7;`
- `padding: 56px 24px 32px;`

**布局：** 上方链接区（grid 4 列），下方版权行

**链接区（4 列）：**

| 列 | 标题 | 链接 |
|---|---|---|
| 产品 | 产品 | PWA 应用 `/app` · 桌面端下载 `#download` · 快捷指令 `#presets` |
| 资源 | 资源 | GitHub 仓库 · 使用文档 · 更新日志 |
| 法律 | 法律 | 隐私政策 `/privacy.html` · 服务条款 `/terms.html` · 常见问题 `/faq.html` |
| 关注 | 关注 | （预留：Twitter / 微信公众号 / 邮件订阅，v0.1.0 先留空位） |

**版权行：**
- `© 2026 VoiceBridge. 用语音连接设备。`
- 右侧：版本号 `v0.1.0 内测版`

---

## 6. 技术实现

### 6.1 文件结构

```
hosted-pwa/public/
├── index.html          ← 改为落地页（重写）
├── app.html            ← 原 index.html 改名（PWA 应用入口）
├── style.css           ← 不动（继续作为共享 token 库）
├── landing.css         ← 新增：Hero 暗色 + 指令 section 专属样式
├── landing.js          ← 新增：打字机 + 粒子流 + IntersectionObserver
├── app.js              ← 原 PWA 主逻辑（不动）
├── faq.html, privacy.html, terms.html  ← 不动
├── fonts/, icons/      ← 不动
└── (其他原有文件)
```

**约定：** 落地页相关的所有样式和脚本以 `landing-` 前缀命名，与 PWA 应用代码物理隔离。

### 6.2 路由调整

修改 `hosted-pwa/worker/static.js`：

```javascript
// 原：所有路径都 fallback 到 /index.html
// 改：精确路由
const ROUTES = {
  '/':        '/index.html',     // 落地页
  '/app':     '/app.html',       // PWA 应用
  '/app/':    '/app.html',
};

export async function onRequestGet({ env }) {
  const url = new URL(request.url);
  const mapped = ROUTES[url.pathname];

  if (mapped) {
    // 已知路由 → 返回对应 HTML
    return env.ASSETS.fetch(new Request(new URL(mapped, url.origin), request));
  }

  // 其他路径（含 /style.css, /fonts/, /icons/ 等）→ Cloudflare ASSETS 默认行为
  return env.ASSETS.fetch(request);
}
```

**注意：**
- `/app` 路径在落地页的"打开应用"按钮、Footer 链接、manifest 的 `start_url` 中需要全部更新
- 原 `index.html` 中所有指向 `/` 的内部跳转需改为 `/app`
- manifest.json 的 `start_url` 从 `/` 改为 `/app`
- service worker（如果有）的缓存列表需加入 `/app.html`

### 6.3 landing.js 核心模块

```javascript
// === 1. 打字机 ===
class Typewriter {
  constructor(element, lines, options = {}) {
    this.el = element;
    this.lines = lines;
    this.speed = options.speed ?? 65;
    this.pause = options.pause ?? 1800;
    this.clearSpeed = options.clearSpeed ?? 25;
    this.lineIdx = 0;
    this.charIdx = 0;
    this.isDeleting = false;
  }
  start() { this.tick(); }
  tick() {
    const line = this.lines[this.lineIdx];
    if (!this.isDeleting) {
      this.charIdx++;
      this.el.textContent = line.slice(0, this.charIdx);
      if (this.charIdx >= line.length) {
        // 打完一行，等待 pause 后开始删除
        setTimeout(() => { this.isDeleting = true; this.tick(); }, this.pause);
        return;
      }
      setTimeout(() => this.tick(), this.speed);
    } else {
      this.charIdx--;
      this.el.textContent = line.slice(0, this.charIdx);
      if (this.charIdx <= 0) {
        this.isDeleting = false;
        this.lineIdx = (this.lineIdx + 1) % this.lines.length;
      }
      setTimeout(() => this.tick(), this.clearSpeed);
    }
  }
}

// === 2. NAV 背景切换 ===
const nav = document.querySelector('.nav');
const hero = document.querySelector('#hero');
const observer = new IntersectionObserver(
  ([entry]) => {
    nav.classList.toggle('nav-light', !entry.isIntersecting);
  },
  { threshold: 0.05 }
);
observer.observe(hero);

// === 3. 文档打字机（快捷指令 section 的右侧 mockup）===
// 使用同一个 Typewriter 类，但绑定不同的 element 和 lines

// === 4. reduced-motion 降级 ===
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  // 直接显示第一行完整内容，禁用打字机和粒子流动画
  document.querySelectorAll('.particle').forEach(p => p.style.display = 'none');
}
```

### 6.4 复用 PWA 资源的清单

| 资源 | 路径 | 在落地页的用法 |
|---|---|---|
| 全局 token | `/style.css` | `<link>` 引入，所有 `:root` 变量直接可用 |
| 字体 | `/fonts/Nunito-Variable.woff2` | 由 `style.css` 中的 `@font-face` 自动加载 |
| Mono 字体 | `/fonts/JetBrainsMono-Variable.woff2` | 同上，用于指令 section 的"已触发"行 |
| 主图标 | `/icons/icon-192.png` | NAV logo + Footer logo |
| 高清图标 | `/icons/icon-512.png` | favicon（可选） |

**禁止**：引入任何外部字体 CDN、外部图标库（如 Font Awesome）。所有视觉资产自托管。

### 6.5 移动端响应式断点

```css
/* 默认样式以桌面端为基准 */

@media (max-width: 900px) {
  /* 平板：3 列 → 2 列 */
  .features-grid { grid-template-columns: repeat(2, 1fr); }
  .preset-grid { grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .download-grid { grid-template-columns: 1fr; max-width: 400px; margin: 0 auto; }
  .steps-grid { grid-template-columns: 1fr; }
  /* 快捷指令上半身：手机+电脑对比简化为只显示手机 */
  .preset-duo { grid-template-columns: 1fr; }
  .preset-duo .laptop-mockup { display: none; }
  .preset-duo .arrow { transform: rotate(90deg); }
}

@media (max-width: 600px) {
  /* 手机：单列堆叠 */
  .features-grid { grid-template-columns: 1fr; }
  .preset-grid { grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .hero-title { font-size: clamp(40px, 12vw, 56px); }
  .nav-links { display: none; }  /* 移动端隐藏中间锚点 */
  .footer-links { grid-template-columns: 1fr 1fr; }
}
```

### 6.6 GitHub Releases 下载链接

下载按钮的 `href` 直接指向 GitHub Releases asset URL：

```
https://github.com/{owner}/{repo}/releases/download/v0.1.0/VoiceBridge-Agent-{platform}-{arch}-0.1.0.zip
```

**关键：**
- 添加 `target="_blank"` + `rel="noopener"` 让浏览器在新标签打开
- GitHub asset URL 会自动 302 重定向到 `objects.githubusercontent.com` 的 CDN 下载链接
- 用户点击 = 直接触发下载，无需中间页
- `{owner}/{repo}` 需要在 release 创建后用真实值替换（在 `landing.html` 里用占位符，最后用 sed 或构建脚本替换）

**Release 创建流程：**
1. 在 `out/make/zip/` 下打包好三个 ZIP 文件
2. 访问 `https://github.com/{owner}/{repo}/releases/new`
3. 创建 `v0.1.0` tag
4. 上传三个 ZIP 作为 assets
5. 发布（设置为本内测期的 first release）

---

## 7. 成功标准

| 维度 | 标准 |
|---|---|
| **视觉** | 第一眼识别出"暗色橙辉光"风格，与 PWA 的暖橙 token 一致 |
| **转化** | 用户从落地页到下载点击 ≤ 2 次滚动 |
| **性能** | Lighthouse Performance ≥ 90（移动端）；LCP < 2s |
| **可访问性** | 键盘 Tab 可达所有交互元素；reduced-motion 用户能看到完整内容 |
| **响应式** | 320px / 768px / 1024px / 1440px 四个断点视觉无破版 |
| **代码** | `landing.html/css/js` 三文件总行数 < 2000 行；通过 HTML/CSS 验证 |

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| GitHub Releases 链接未发布时 404 | 用占位符 `#download-pending` + 控制台 warning；构建脚本检测真实链接替换 |
| 暗色 Hero + 浅色 section 切换生硬 | 在 Hero 底部加 `linear-gradient` 过渡 30vh 高度的"褪色"区域 |
| 粒子流动画在低端机性能问题 | 限制粒子数 ≤ 8；`prefers-reduced-motion` 直接隐藏 |
| 打字机在 Safari iOS 表现不一致 | 用 `setTimeout` 而非 `requestAnimationFrame`；测试后修复 |
| `/app` 路由破坏现有 PWA 用户书签 | 在 `/` 自动跳转落地页（不强制跳 `/app`）；旧链接继续工作 |

---

## 9. 实施顺序（粗粒度，给后续 plan 用）

1. **路由层**：修改 `worker/static.js`，添加 `/` → `index.html` 和 `/app` → `app.html` 映射；重命名原 `index.html` → `app.html`
2. **骨架**：创建 `landing.html`，搭 6 个 section 的空结构 + nav + footer
3. **样式**：创建 `landing.css`，先写 Hero 暗色 token 和样式
4. **Hero 动效**：实现打字机 + 粒子流 + reduced-motion 降级
5. **功能卡 + 流程**：填内容，套用 PWA 卡片样式
6. **快捷指令 section**：手机+电脑 mockup + 指令卡片网格 + 文档打字机
7. **下载区**：三平台卡片 + GitHub Releases 占位符
8. **响应式**：900px / 600px 断点适配
9. **校验**：HTML/CSS 验证 + Lighthouse + 4 断点视觉走查

---

## 10. 待用户审阅项

在进入实施 plan 之前，请确认以下细节：

- [ ] Hero 文案"说，即是写。" 是否最终敲定？
- [ ] 打字机轮播 3 条文案是否合适？需要加更多条吗？
- [ ] 快捷指令卡片 8 张（7 预设 + 1 自定义入口）够不够？
- [ ] 下载区的 GitHub `{owner}/{repo}` 占位符是否替换为真实仓库地址？
- [ ] 是否需要加邮件订阅表单（用于内测期收集 leads）？默认不做。

---

**结束。等待用户审阅后，将调用 writing-plans 技能生成详细实施计划。**
