# VoiceBridge 双语官网落地页设计文档

**日期：** 2026-08-01

**分支：** cloud-activation

**目标版本：** v0.1.0

**文档版本：** v4

**状态：** 已完成暗色 Hero、双语字体排版、响应式栅格与素材发布门槛审查，可进入实施计划

---

## 1. 项目目标

为 VoiceBridge 建立一个默认英文、可切换简体中文的产品官网。官网负责解释产品价值、展示真实工作流、引导用户打开手机网页并下载桌面端，同时不破坏现有 PWA、登录回跳和已安装用户的启动路径。

### 1.1 主要目标

1. **快速说明产品：** 用户在首屏理解 VoiceBridge 是“手机说话，电脑输入”的跨设备语音输入工具。
2. **建立可信度：** 使用真实产品录屏和真实界面截图，不使用虚构界面或无法验证的营销数字。
3. **完成双端激活：** 引导用户打开手机端 PWA、安装桌面端，并使用同一账号连接。
4. **支持国际访问：** 英文为默认版本，中文为完整且可独立访问的版本。
5. **保护现有用户：** 根路径迁移后，旧版已安装 PWA、OAuth 回跳和密码重置仍能进入 `/app`。

### 1.2 成功路径

```text
首次访问官网
  -> 理解手机到电脑的输入流程
  -> 打开 Web App 或下载桌面端
  -> 两端登录同一账号
  -> 完成第一次语音输入
```

### 1.3 本次范围

- 英文和简体中文两个完整官网版本
- `/`、`/zh-CN/`、`/app` 路由调整
- 响应式导航、语言切换、Hero、产品能力、快捷指令、使用流程、下载和 Footer
- 真实产品录屏、截图及其静态回退图
- SEO、Open Graph、结构化数据、sitemap 和 robots
- PWA 根路径迁移兼容
- Supabase Auth 回跳路径调整说明
- 下载产物清单和构建期校验
- 可访问性、性能和基础转化事件定义

### 1.4 本次不做

- 定价对比 section
- 用户评价和客户 Logo 墙，当前没有可验证素材
- 邮件订阅表单
- A/B 测试框架
- 第三方营销像素或跨站追踪
- 对 PWA 产品界面进行视觉重构

---

## 2. 设计判断

**Design Read：** 面向个人效率用户和开发者的 SaaS 官网，以圆润友好的双语排版承载真实产品内容，并用暗色灰橙辉光和克制的跨设备粒子流建立 VoiceBridge 的视觉签名。

| 维度 | 数值 | 说明 |
|---|---:|---|
| `DESIGN_VARIANCE` | 6 | 使用非对称 Hero 和不等分内容布局，但保持产品易读性 |
| `MOTION_INTENSITY` | 6 | Hero 同时包含粒子、打字机和产品媒体，但通过错峰启动、低透明度与 Reduced Motion 控制注意力 |
| `VISUAL_DENSITY` | 4 | 保持官网节奏紧凑，避免 440vh 以上的冗长页面 |

### 2.1 视觉方向

- 保留暖橙品牌色；英文和数字使用 Nunito，中文使用明确的圆润中文字体栈，避免依赖不可控的浏览器默认回退。
- **Hero 区采用暗色橙辉光主题**（已确认决策 B）：深色径向背景 + 橙色辉光球 + 打字机副标题 + 背景微弱粒子流。暖橙渐变在暗色背景里像火焰发光，是 VoiceBridge 的核心视觉签名。
- Hero 之后的 section 经过 64-96px 的短过渡切换回暖白浅色主题，形成“暗色高潮 → 浅色细节”的单次主题转场；不使用贯穿多个 section 的长渐变。
- Footer 回到深色收尾。
- 只使用一个橙色强调色体系，不加入紫色、蓝色或绿色装饰色。
- Hero 内部使用非对称双栏（左侧文案 + 右侧真实产品录屏占位），但保留暗色辉光球作为整页背景层。
- 不使用三张完全等宽的功能卡。
- 不为每个 section 添加英文大写 eyebrow。全页最多使用两处。
- 不使用 div 拼出的手机、电脑或文档假截图。
- 不展示版本号、构建号、虚构数据或空白社交媒体栏位。

### 2.2 主题和形状规则

- 页面主题：Hero 与 Footer 为暗色，其余 section 为暖白浅色。
- Hero 暗色专属 token 在 §8 中独立定义。
- 卡片圆角：`16px`。
- 大型媒体容器圆角：`24px`。
- 输入和次级控件圆角：`10px`。
- CTA 按钮允许胶囊形，但卡片不得使用胶囊形。
- 阴影使用暖色透明阴影（Hero 暗色区除外），不使用纯黑强投影和外发光。

---

## 3. 双语信息架构

### 3.1 URL 设计

| URL | 语言 | 用途 |
|---|---|---|
| `/` | English | 默认官网和英文 canonical |
| `/zh-CN/` | 简体中文 | 中文官网和中文 canonical |
| `/app` | 产品当前语言 | 原 PWA 应用入口 |
| `/privacy.html?lang=en` | English | 英文隐私政策 |
| `/privacy.html?lang=zh` | 简体中文 | 中文隐私政策 |
| `/terms.html?lang=en` | English | 英文服务条款 |
| `/terms.html?lang=zh` | 简体中文 | 中文服务条款 |
| `/faq.html?lang=en` | English | 英文 FAQ |
| `/faq.html?lang=zh` | 简体中文 | 中文 FAQ |

### 3.2 默认语言规则

1. `/` 永远返回完整英文 HTML，不根据浏览器语言自动跳转。
2. `/zh-CN/` 永远返回完整中文 HTML。
3. 语言切换是普通链接导航，不依赖 JavaScript 才能工作。
4. 用户点击语言切换时，同时写入现有 `voicebridge_locale`：英文写 `en`，中文写 `zh-CN`。
5. 点击“Open web app / 打开网页版”时，PWA 继承最近一次主动选择的语言。
6. 不在首屏加载后替换整页文案，避免闪烁、布局移动和搜索引擎只看到一种语言。

### 3.3 语言切换行为

- 桌面端位于导航右侧，标签显示目标语言：英文页显示“中文”，中文页显示“English”。
- 移动端位于展开菜单顶部。
- 切换时保留语义相同的锚点，例如 `/#download` 对应 `/zh-CN/#download`。
- 不使用国旗表示语言。
- 链接具备可读的 `hreflang` 和 `aria-label`。

### 3.4 静态输出策略（已确认：构建期生成路线）

**决策：** 英文和中文页面由同一模板在构建期生成两份独立 HTML。

**为何不复用现有 PWA 的 i18n.js 运行时方案：**

1. **SEO**：Google 爬虫直接看到对应语言的完整 HTML，不会只抓到默认语言。
2. **首屏体验**：无 `data-i18n` 属性 + JS 替换造成的首屏闪烁。
3. **关注点分离**：官网和应用各自演进。PWA 的 `/app` 继续用现有 `i18n/i18n.js`（已工作），官网走构建期，两套并存但耦合度为零。
4. **国际发布**：Product Hunt / Hacker News 等英文渠道进入 `/` 直接看到英文版，无需 JS 切换。

**目录结构：**

```text
hosted-pwa/
├── landing/
│   ├── template.html          # 官网模板，含 {{ i18n.key }} 占位
│   └── locales/
│       ├── en.json
│       └── zh-CN.json
├── scripts/
│   ├── build-landing.mjs      # 新增：template + locale → 两份 HTML
│   └── build-static.mjs
└── public/
    ├── index.html             # 构建生成，英文官网
    ├── zh-CN/index.html       # 构建生成，中文官网
    ├── app.html               # 原 PWA index.html
    ├── landing.css
    ├── landing.js
    └── downloads.json
```

**构建规则：**

- `en.json` 和 `zh-CN.json` 必须拥有完全相同的 key 树。
- 构建时发现缺失 key、空值或未替换占位符（如 `{{ ... }}` 残留）就立即失败。
- 模板使用极简 `{{ a.b.c }}` 语法，由 `build-landing.mjs` 自实现替换，不引入第三方模板引擎依赖。
- `build-landing.mjs` 集成到现有 `npm run build` 流程，先于 `build-static.mjs` 执行。

---

## 4. SEO 和分享元数据

### 4.1 英文元数据

```html
<html lang="en">
<title>VoiceBridge - Speak on Your Phone, Type on Your Computer</title>
<meta name="description" content="Use your phone as a voice input remote for your computer. VoiceBridge transcribes speech, sends text to the active field, and runs reusable commands." />
<link rel="canonical" href="https://voicebridge-6kr.pages.dev/" />
<link rel="alternate" hreflang="en" href="https://voicebridge-6kr.pages.dev/" />
<link rel="alternate" hreflang="zh-CN" href="https://voicebridge-6kr.pages.dev/zh-CN/" />
<link rel="alternate" hreflang="x-default" href="https://voicebridge-6kr.pages.dev/" />
```

### 4.2 中文元数据

```html
<html lang="zh-CN">
<title>VoiceBridge - 手机说话，电脑输入</title>
<meta name="description" content="把手机变成电脑的语音输入遥控器。VoiceBridge 支持语音转写、当前输入框发送和可复用快捷指令。" />
<link rel="canonical" href="https://voicebridge-6kr.pages.dev/zh-CN/" />
<link rel="alternate" hreflang="en" href="https://voicebridge-6kr.pages.dev/" />
<link rel="alternate" hreflang="zh-CN" href="https://voicebridge-6kr.pages.dev/zh-CN/" />
<link rel="alternate" hreflang="x-default" href="https://voicebridge-6kr.pages.dev/" />
```

### 4.3 其他 SEO 资源

- 两种语言分别提供 Open Graph 和 Twitter Card 文案。
- 使用一张真实产品演示构图作为 `og:image`，尺寸 `1200x630`。
- 添加 `SoftwareApplication` JSON-LD，操作系统仅写实际提供的 macOS 和 Windows。
- 添加 `sitemap.xml`，包含英文、中文和语言互链。
- 添加 `robots.txt`，允许索引官网，是否索引 `/app` 由产品策略明确决定。
- 官网页面不引入 PWA manifest，只有 `/app` 引入 manifest，避免用户把营销页安装成 PWA。

---

## 5. 文案原则

### 5.1 必须遵守

- 英文文案独立编写，不逐字翻译中文口号。
- 中文保留简洁、直接的产品语气。
- 不使用没有数据支持的“输入速度 ×3”。
- 不承诺“不到 2 分钟”，除非实际计时验证通过。
- 不使用“全平台”，应明确写 macOS 和 Windows。
- 不把 Cloud Mode 描述为完全本地运行。
- 不承诺所有输入框都能自动粘贴。应说明不支持时文字仍保留在剪切板。
- 不使用“全部免费”。应写“Free plan available / 可使用免费方案”。
- 官网示例与系统内置预设必须分开标注。
- 页面可见文案不使用长破折号或连续的装饰性中点。

### 5.2 核心文案

| 位置 | English | 简体中文 |
|---|---|---|
| Hero H1 | Speak on your phone. Type on your computer. | 说，即是写。 |
| Hero body | Hold to record. VoiceBridge transcribes your speech and sends it to the active text field. | 手机说话，电脑输入。按住录音，松开转写，VoiceBridge 会把文字发送到电脑当前输入框。 |
| Primary CTA | Download desktop app | 下载桌面端 |
| Secondary CTA | Open web app | 打开网页版 |
| Capability title | Voice input without switching windows | 不切窗口，直接输入 |
| Commands title | Reuse the text you type every day | 常用长文本，说一句就触发 |
| How title | Connect both devices, then speak | 两端连接，然后开始说 |
| Download title | Choose your desktop app | 选择你的桌面端 |

---

## 6. 页面结构

```text
┌────────────────────────────────────────────┐
│ NAV（sticky, 半透明 + blur）                │
│  Logo | Product | Commands | How | Download│
│       中文/English | Open app               │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ SECTION 1: HERO（暗色橙辉光，min-100dvh）   │
│  ┌──────────────┬───────────────────┐     │
│  │ 左：H1 大字   │ 右：录屏占位       │     │
│  │ 打字机副标题  │ (video tag 预留)   │     │
│  │ 主/次 CTA    │                   │     │
│  └──────────────┴───────────────────┘     │
│  + 背景辉光球 + 微弱粒子流                  │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ SECTION 2: 产品能力（浅色，由内容决定高度） │
│  ┌──────────────────────────────────┐      │
│  │ 主面板：跨设备输入（含录屏/截图占位）│      │
│  ├────────────┬───────────────────┤      │
│  │ 辅助：当前  │ 辅助：剪切板兜底    │      │
│  │ 输入位置    │                   │      │
│  └────────────┴───────────────────┘      │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ SECTION 3: 快捷指令（浅色）                │
│  ┌──────────────┬───────────────────┐     │
│  │ 左：PWA 指令  │ 右：4 个代表性     │     │
│  │ 库截图占位    │ 预设条目           │     │
│  └──────────────┴───────────────────┘     │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ SECTION 4: 使用流程（浅色）                │
│  ① 打开网页版  →  ② 安装桌面端  →  ③ 说    │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ SECTION 5: 下载（浅色，id="download"）     │
│  [推荐平台大卡] [其他平台紧凑选项]          │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ FOOTER（暗色，#1c1917）                    │
│  Product | Resources | Legal | Language    │
└────────────────────────────────────────────┘
```

**配色分布：** 暗色 → 浅色 → 浅色 → 浅色 → 浅色 → 浅色 → 暗色。
Hero 与 Footer 首尾呼应，中间 4 个 section 统一暖白浅色。

页面不设置总 `vh` 高度目标。所有 section 由内容决定高度。

---

## 7. 各 Section 详细设计

### 7.1 导航

**位置：** sticky top，桌面高度 68px。

**背景状态：**

- 位于 Hero 内：`rgba(13, 10, 8, 0.55)` 深色半透明表面、暖白文字和轻微 blur；Logo、语言入口与次级链接均需在暗色背景上通过对比度检查。
- 离开 Hero 后：暖白半透明表面、深色文字、轻微 blur 和底部分隔线。
- 两种状态使用 180-240ms 的颜色、背景和边框过渡，不改变导航高度，不引起布局移动。

**层级：** `z-index: 30`，统一记录在 landing 层级约定中。

桌面内容：

- 左侧：24px 产品图标和 VoiceBridge。
- 中间：Product、Commands、How it works、Download。
- 右侧：语言切换、GitHub 图标链接、Open app。

移动端：

- 保留 Logo、语言入口和菜单按钮。
- 展开菜单必须支持 `aria-expanded`、Esc 关闭、焦点返回和点击外部关闭。
- 菜单打开时阻止背景滚动。
- 导航链接点击后关闭菜单。

### 7.2 Hero

**布局：** `min-height: 100dvh`，最大内容宽度 1240px。Hero 使用独立的内容断点：`>= 1080px` 使用 `1.05fr 0.95fr` 非对称双栏、列间距 64px；`< 1080px` 切换为单列。该断点用于保证英文 H1 的两行宽度，不受全局 desktop 断点限制。媒体的视觉中心与左侧整组文案的视觉中心对齐，不只做顶部对齐。

**主题（已确认决策 B）：** 暗色橙辉光。

- 背景：`radial-gradient(ellipse at top right, #2a1810 0%, #1a1310 60%, #0d0a08 100%)`。
- 装饰辉光球（绝对定位、`filter: blur()`）：
  - 顶部右侧：`480×480px`, `background: rgba(234, 88, 12, 0.28)`, `filter: blur(100px)`, `top: -120px; right: -100px;`
  - 底部左侧：`360×360px`, `background: rgba(249, 115, 22, 0.16)`, `filter: blur(110px)`, `bottom: -100px; left: -80px;`
- 背景粒子流层：6-8 个、核心尺寸 2-4px 的橙色粒子，CSS `@keyframes` 驱动，单次轨迹 6-10 秒，`opacity: 0.12-0.20`，`pointer-events: none`。轨迹从手机一侧朝电脑媒体区移动，并通过 mask 将主要活动范围限制在 Hero 中部至右侧；粒子不得穿过 H1 和 CTA，也不得延伸到正文 section。
- 固定层级：背景 `0`、辉光 `1`、粒子 `2`、文案和产品媒体 `3`、导航 `30`。
- 文字颜色：H1 主体用 `#f4f1ed`，"即是写 / type on your computer"用 `linear-gradient(135deg, #f97316, #fdba74)` + `background-clip: text`。

**顶部与内部节奏：** 导航到内容 88-96px；H1 到打字机 24-28px；打字机到 CTA 28-32px；CTA 间距 12px。

左侧内容（最多 4 类）：

1. **静态 H1 大字**（不参与打字机）：
   - English: `Speak on your phone.` 换行 `Type on your computer.`
   - 中文：`说，` 换行 `即是写。`（"即是写"用橙色渐变文字）
   - English：`clamp(48px, 4.8vw, 68px)`，权重 800，字距 `-0.025em`，行高 1.02
   - 中文：`clamp(52px, 6vw, 76px)`，权重 700-800，字距 `-0.01em`，行高 1.08
   - 两种语言均使用 `text-wrap: balance`，桌面目标为两行；不得通过压缩字距或缩放变形强行塞入两行
2. **打字机副标题**（白色逐字打出，循环 3 条文案）：
   - English: `VoiceBridge transcribes your speech and sends it to the active text field.` 等三条轮播
   - 中文：`手机说话 → 文字自动出现在电脑光标处。` 等三条轮播
   - 字号：`clamp(16px, 1.5vw, 19px)`，行高 1.6，颜色 `#f4f1ed`
   - 容器预留当前语言最长文案的高度，切换内容不得推动 CTA 或引起 CLS
   - 英文打字速度 32-40ms/字符，中文 60-70ms/字；停留 1800ms，清空 25ms/字符
   - 光标：3px 宽 / 1.1em 高，颜色 `#f97316`，闪烁周期 900ms，`steps(1)`
3. **两个 CTA**（在打字机下方）：
   - 主 CTA: `Download desktop app / 下载桌面端` — `var(--hero-button-primary-gradient)` + 暖色阴影；不复用亮橙文字渐变作为按钮背景
   - 次 CTA: `Open web app / 打开网页版` — `rgba(255,255,255,0.08)` 半透明 + `1px solid rgba(255,255,255,0.15)` 边框，指向 `/app`
4. **无额外版本号、平台清单或信用卡提示**（保持 Hero 纯净）

右侧使用真实产品演示（**本次实施交付占位，录屏后续替换**）：

- 桌面占位区使用 `aspect-ratio: 16/10`，移动端使用 `4/3`；背景 `rgba(255,255,255,0.04)`，边框 `1px solid rgba(249, 115, 22, 0.2)`，圆角 `var(--landing-radius-media)`，内部居中显示 "Product demo coming soon / 产品演示即将上线" 文字 + 播放图标。
- 占位必须预留 `<video>` 标签位置（包含 `poster`、`muted autoplay loop playsinline` 属性），素材未就绪时不输出 `src` 或 `<source>`，poster 指向占位图，避免空 URL 请求当前页面。
- 真实素材到位后的目标规格：8-12 秒静音循环 `webm` + `mp4` fallback，展示手机按住录音 → 松开 → 电脑活动输入框出现文字的完整链路。
- 录屏内不展示真实邮箱、用户姓名、Token 或其他敏感数据。
- 移动端仍显示此占位/视频区域，不隐藏。

**打字机文案（每语言 3 条轮播）：**

```json
{
  "en": [
    "VoiceBridge transcribes your speech and sends it to the active text field.",
    "Hold to record on your phone. Release. Text appears on your computer.",
    "Wrap long templates into commands. Trigger them with one sentence."
  ],
  "zh-CN": [
    "手机说话 → 文字自动出现在电脑光标处。",
    "按住手机录音，松开即转写，无需切换窗口。",
    "把常用长文本封装成指令，说一句话就触发。"
  ]
}
```

**JS 实现位置：** `landing.js` 中的 `Typewriter` 类（参见 §9）。

### 7.3 产品能力

**标题：** Voice input without switching windows / 不切窗口，直接输入。

**布局：** 桌面使用 12 栏栅格，主能力大面板占 7 栏，右侧两个辅助面板占 5 栏并纵向排列，间距 24px；面板内边距 32-40px，主媒体优先使用 `16/10`。不使用三等分卡片。

内容：

1. **跨设备输入：** 手机负责录音，电脑端接收转写结果。
2. **当前输入位置：** 文字尝试发送到当前输入框。
3. **剪切板兜底：** 自动粘贴不可用时，文字仍保留在电脑剪切板。

主面板使用真实录屏的第二个短片或静态截图。辅助面板使用真实状态截图或简洁的文字和图标，不制作假窗口。

### 7.4 快捷指令

**标题：** Reuse the text you type every day / 常用长文本，说一句就触发。

**布局：** 桌面端左侧真实 PWA 指令库竖向截图占 38-42%，右侧 4 个代表性指令条目占 58-62%，列间距 56-64px。移动端截图居中且最大宽度 360px，条目在空间允许时使用两列。

展示当前数据库中真实存在的代表性预设：

| English label | 中文标签 | 来源 |
|---|---|---|
| Minimal changes | 最小化修改 | 内置预设 |
| Code review | 代码审查 | 内置预设 |
| UI design | UI 设计 | 内置预设 |
| Quick overview | 快速概览 | 内置预设 |

下方说明：

- English: `11 built-in presets. Add your own commands for repeated text.`
- 中文：`内置 11 条预设，也可以把重复文本保存成自己的指令。`

如果展示“周报模板”或“会议纪要”，必须标注为 user-created example / 用户自定义示例，不得称为内置预设。

条目本身不是可点击控件时不显示手型光标，也不增加 hover 触发动作。

### 7.5 使用流程

**标题：** Connect both devices, then speak / 两端连接，然后开始说。

**布局：** 桌面端使用开放式三列时间线，列间距 40px；移动端使用纵向三步。不为三步增加完全相同的卡片外壳。使用真实动词作为标题，不显示“Stage 1”一类标签。

| 序号 | English | 简体中文 |
|---:|---|---|
| 1 | **Open the web app.** Create an account or sign in on your phone. | **打开网页版。** 在手机上创建账号或登录。 |
| 2 | **Install the desktop app.** Sign in with the same account. | **安装桌面端。** 使用同一个账号登录。 |
| 3 | **Speak.** Hold to record, release, and keep typing on your computer. | **开始说。** 按住录音，松开后继续在电脑上输入。 |

不显示虚构的 120x80 mini 截图。若无真实截图，每步只使用一个统一图标和短说明。

### 7.6 下载

**标题：** Choose your desktop app / 选择你的桌面端。

**布局：** 根据 `navigator.userAgentData` 或 `navigator.platform` 突出推荐项，但不得隐藏其他平台。检测失败时按 macOS Apple Silicon、macOS Intel、Windows 的顺序展示。

平台：

| 平台 | 架构 | 当前构建产物 |
|---|---|---|
| macOS | Apple Silicon | `VoiceBridge Agent-darwin-arm64-0.1.0.zip` |
| macOS | Intel | `VoiceBridge Agent-darwin-x64-0.1.0.zip` |
| Windows | x64 | `VoiceBridge Agent-win32-x64-0.1.0.zip` |

下载信息由构建脚本生成的 `/downloads.json` 提供：

```json
{
  "version": "0.1.0",
  "repository": "Golden-forest/VoiceBridge",
  "assets": [
    {
      "platform": "darwin",
      "arch": "arm64",
      "filename": "VoiceBridge Agent-darwin-arm64-0.1.0.zip",
      "size": null,
      "minimumOs": null,
      "url": null
    }
  ]
}
```

构建要求：

- 从真实 `out/make/zip/` 产物读取文件名和大小。
- Release 创建后注入真实 URL，不在 HTML 中保留 `{owner}/{repo}`。
- URL 为空或 HEAD 校验失败时，对应按钮显示“Coming soon / 即将提供”，不可指向 `#`。
- 直接下载不强制打开新标签。
- 系统最低版本只有在实际验证后才能展示。
- “Free plan available. No credit card required.” 与“可使用免费方案，无需信用卡”可以作为下载区说明，但不写“全部免费”。

### 7.7 Footer

Footer 只放真实可用链接：

- Product：Open app、Download、Commands
- Resources：GitHub、FAQ
- Legal：Privacy、Terms
- Language：English、简体中文

不保留空白 Twitter、微信公众号或邮件订阅栏位，不显示营销页版本号。

---

## 8. 视觉 Token

复用 PWA 中已存在的品牌 Token，但在 `landing.css` 内重新映射为官网语义 Token，避免直接依赖所有应用组件样式。

```css
:root {
  /* 字体：Nunito 当前仅覆盖 Latin，中文必须有显式字体栈 */
  --font-display: "Nunito", "MiSans", "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", sans-serif;
  --font-body: "Nunito", "MiSans", "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", sans-serif;
  --font-mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;

  /* 浅色 section（功能 / 流程 / 下载） */
  --landing-bg: #fffbf5;
  --landing-surface: #ffffff;
  --landing-surface-muted: #fff5eb;
  --landing-text: #1c1917;
  --landing-text-muted: #625b55;
  --landing-accent: #c2410c;
  --landing-accent-hover: #9a3412;
  --landing-on-accent: #fffaf5;
  --landing-border: rgba(120, 70, 35, 0.16);
  --landing-focus: #9a3412;
  --landing-radius-control: 10px;
  --landing-radius-card: 16px;
  --landing-radius-media: 24px;

  /* === Hero 暗色专属（决策 B）=== */
  --hero-bg: radial-gradient(ellipse at top right,
              #2a1810 0%, #1a1310 60%, #0d0a08 100%);
  --hero-text: #f4f1ed;
  --hero-text-muted: #c1bdb7;
  --hero-accent: #f97316;
  --hero-accent-soft: #fdba74;
  --hero-accent-deep: #ea580c;
  --hero-accent-gradient: linear-gradient(135deg, #f97316, #fdba74);
  --hero-button-primary-gradient: linear-gradient(135deg, #c2410c, #9a3412);
  --hero-glow-1: rgba(234, 88, 12, 0.28);
  --hero-glow-2: rgba(249, 115, 22, 0.16);
  --hero-border: rgba(249, 115, 22, 0.2);
  --hero-surface: rgba(255, 255, 255, 0.04);
  --hero-button-secondary-bg: rgba(255, 255, 255, 0.08);
  --hero-button-secondary-border: rgba(255, 255, 255, 0.15);

  /* === 打字机 === */
  --cursor-color: #f97316;
  --cursor-width: 3px;
  --type-speed-en: 36ms;
  --type-speed-zh: 65ms;
  --type-pause: 1800ms;
  --type-clear-speed: 25ms;

  /* === 粒子流 === */
  --particle-color: #f97316;
  --particle-glow: 0 0 6px rgba(249, 115, 22, 0.6), 0 0 14px rgba(249, 115, 22, 0.28);
  --particle-opacity: 0.16;

  /* === Footer 暗色 === */
  --footer-bg: #1c1917;
  --footer-text: #c1bdb7;
  --footer-text-muted: #8a827c;
  --footer-border: rgba(255, 255, 255, 0.08);
}
```

**说明：** Hero 暗色 token 与浅色 token 完全独立，避免互相污染。亮橙渐变只用于标题和装饰；Hero 主 CTA 使用更深的 `--hero-button-primary-gradient`，确保白色普通字号文字达到 WCAG AA。在浅色 section 中 CTA 使用 `--landing-accent` 纯色。

### 8.1 双语字体与排版系统

当前项目自托管的 Nunito 为 Latin subset，只负责英文、数字和拉丁符号。实现时必须为中文指定显式字体栈，不得只写 `sans-serif` 后依赖浏览器随机回退。

字体策略：

- 默认低依赖方案：Nunito + `PingFang SC` + `Microsoft YaHei UI` + `Noto Sans SC`。
- 推荐一致性方案：英文和数字使用 Nunito，中文正文自托管 MiSans；引入前必须核对并记录字体版本、子集范围和许可文件。
- 如需更强的中文标题个性，可仅在中文 H1 评估得意黑；不得用于正文、导航和移动端密集 UI。
- JetBrains Mono 只用于命令、平台架构、文件大小和代码，不用于普通 eyebrow、正文或功能标题。
- 页面根节点设置 `font-synthesis: none` 和 `font-optical-sizing: auto`；实际使用字重限定为 400、600、700、800。

排版规格：

| 元素 | English | 简体中文 |
|---|---|---|
| Hero H1 | `clamp(48px, 4.8vw, 68px)` / 800 / 1.02 / `-0.025em` | `clamp(52px, 6vw, 76px)` / 700-800 / 1.08 / `-0.01em` |
| Section H2 | `clamp(32px, 4vw, 48px)` / 700-800 / 1.15 | `clamp(30px, 3.8vw, 46px)` / 700 / 1.2 |
| 正文（桌面） | 17px / 1.65，最大宽度 58-62ch | 17px / 1.7，最大宽度 28-32em |
| 正文（移动端） | 16px / 1.65 | 16px / 1.75 |
| 导航 | 14px / 700 | 14px / 600 |
| CTA | 15px / 700 / 不换行 | 15px / 700 / 不换行 |

- H1 和 Section H2 使用 `text-wrap: balance`，正文不使用强制 balance。
- 中英文分别设置字距和行高，不用一组紧缩参数覆盖两种书写系统。
- Section 标题到主媒体或内容栅格间距 48-64px。
- Section 上下留白：桌面 112px、平板 80px、移动端 64px。
- 字体文件必须设置 `font-display: swap` 并预加载首屏实际使用的最小子集；为媒体和打字机区域预留尺寸，字体切换后 CLS 仍需小于 0.1。

**其他视觉规则：**

- 主按钮采用经过对比度验证的颜色，普通字号至少达到 WCAG AA 4.5:1。
- 正文、次级文字、边框、Focus ring 均需实际测量对比度。
- 保留 Nunito 和 JetBrains Mono 自托管字体，并按 §8.1 明确中文字体来源与回退策略。
- 图标使用同一套开源图标资源并在构建时自托管，不混用 emoji 和多套线性图标。

---

## 9. 动效与可访问性

### 9.1 动效原则

- 视频解释产品工作流。
- 文字抵达动画解释状态变化。
- Hover 和 active 只提供操作反馈。
- 粒子流仅允许存在于 Hero，并遵守 §7.2 的数量、范围、透明度和层级限制；正文不增加粒子。
- 不增加视差、磁吸按钮和滚动劫持。
- 粒子缓慢持续运动；打字机在 Hero 入场后再启动，避免粒子、文字和视频同时争夺注意力。
- 动画仅修改 `transform` 和 `opacity`。

### 9.2 Reduced Motion

`prefers-reduced-motion: reduce` 时：

- 视频不自动播放，显示 poster 和播放按钮。
- 文字抵达动画直接显示最终文本。
- 隐藏 Hero 粒子并直接显示第一条完整的打字机文案。
- 平滑滚动改为即时跳转。
- 禁止无限循环动画。
- 所有 `setTimeout` 和事件监听提供停止或清理逻辑。

### 9.3 屏幕阅读器

- 动态打字区域使用 `aria-hidden="true"`。
- 同一区域提供静态、完整的屏幕阅读器文本。
- 不把循环文字设为 `aria-live`。
- 视频提供描述性标题和文本说明，不依赖画面传达唯一信息。
- 所有装饰图标 `aria-hidden="true"`，功能图标拥有可读标签。

### 9.4 键盘与 Focus

- 所有链接和按钮支持键盘操作。
- 使用清晰的 `:focus-visible` 样式。
- 移动菜单打开后焦点进入菜单，关闭后返回菜单按钮。
- Esc 可以关闭菜单。
- CTA 和语言切换标签在英文和中文下都不得换成两行。

---

## 10. 路由和 PWA 迁移

### 10.1 Worker 路由

当前 Worker 使用 `export default { fetch(request, env) }`。实现时继续使用相同接口，不改成 Pages Functions 的 `onRequestGet`。

目标路由：

```javascript
const HTML_ROUTES = new Map([
  ["/", "/index.html"],
  ["/zh-CN", "/zh-CN/index.html"],
  ["/zh-CN/", "/zh-CN/index.html"],
  ["/app", "/app.html"],
  ["/app/", "/app.html"],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const assetPath = HTML_ROUTES.get(url.pathname);
    if (!assetPath) return env.ASSETS.fetch(request);

    const assetUrl = new URL(assetPath, url.origin);
    assetUrl.search = url.search;
    return env.ASSETS.fetch(new Request(assetUrl, request));
  },
};
```

要求：

- `/` 直接返回官网 HTML，不再 302 到 `/index.html`。
- 保留查询参数，避免认证错误信息或活动参数丢失。
- 静态资源继续交给 `env.ASSETS.fetch`。
- 为 `/`、`/zh-CN/`、`/app`、静态资源和 404 增加测试。

### 10.2 旧版已安装 PWA

现有 manifest 的 `start_url` 是 `/`。根路径改成官网后，旧版已安装 PWA 可能在 standalone 模式打开官网。

迁移方案：

1. 新官网不引用 manifest。
2. `/app.html` 继续引用 manifest。
3. 新 manifest 将 `start_url` 改为 `/app`。
4. 英文根页面在最早可执行位置检测 `display-mode: standalone` 和 iOS `navigator.standalone`。
5. 仅当当前路径为 `/` 且处于 standalone 模式时，使用 `location.replace('/app')`。
6. 普通浏览器访问 `/` 永远停留在英文官网。

该兼容逻辑需要在 Chromium 安装 PWA和 iOS 添加到主屏幕两种场景中验证。

### 10.3 Supabase Auth 回跳

当前 GitHub OAuth 的 `redirectTo` 指向 `/`，迁移时必须改为 `/app`。

上线检查：

- `signInWithOAuth` 的 `redirectTo` 使用完整生产 URL，例如 `https://voicebridge-6kr.pages.dev/app`。
- Supabase Dashboard 的 Redirect URLs 添加完全一致的 `/app` 地址。
- 生产环境使用精确 URL，不使用宽泛通配符。
- Site URL 设置为正式站点根地址。
- 检查注册确认邮件和密码重置模板，确保最终进入 `/app`，而不是官网首页。
- 本地开发地址单独加入允许列表。
- 认证失败时 `/app` 能读取 URL fragment 或 query 中的错误并显示可恢复提示。

---

## 11. 下载发布流程

1. 运行 Electron Forge 生成三个 ZIP。
2. 构建脚本扫描 `out/make/zip/`，确认三种目标产物存在。
3. 生成带真实文件名和大小的 `downloads.json`。
4. 创建 `v0.1.0` GitHub Release，并上传相同文件名的 assets。
5. 注入或生成 GitHub 下载 URL。
6. 对每个 URL 做发布前检查。
7. 官网只在 URL 可用时启用下载按钮。

发布失败条件：

- 缺少任一要求的平台产物。
- HTML 中仍出现 `{owner}`、`{repo}`、`download-pending` 或空 URL。
- `downloads.json` 文件名与 Release asset 不一致。
- 文件大小或平台标签与真实产物不一致。

---

## 12. 基础转化事件

为使“下载转化”可验证，元素先统一声明事件名称。事件接收端可以后续接入，但命名在本次固定。

| 事件 | 触发条件 | 附加字段 |
|---|---|---|
| `landing_open_app` | 点击 Open web app | locale、section |
| `landing_download` | 点击可用下载按钮 | locale、platform、arch、version |
| `landing_language_switch` | 切换语言 | from、to、section |
| `landing_video_play` | 用户主动播放产品视频 | locale、reducedMotion |

要求：

- 不发送邮箱、账号 ID、录音内容或转写文本。
- 不用营销事件阻塞链接导航。
- 若本次不接事件接收端，保留 `data-event` 和事件结构测试。

---

## 13. 响应式规则

统一断点：

```text
mobile:  < 640px
tablet:  640px-1023px
desktop: >= 1024px
wide:    >= 1440px
```

### 13.1 Hero

- `>= 1080px`：双栏 `1.05fr 0.95fr`，最大宽度 1240px，列间距 64px；英文和中文 H1 均不得超过两行。
- `< 1080px`：切换为单栏，文字在上，真实双端演示在下，不保留被挤压的窄双栏。
- Mobile：媒体比例约 4:3；CTA 优先保持单行，空间不足时整组纵向排列，不压缩按钮文字。
- 在 375px、768px、960px、1024px、1080px、1440px 分别验证 H1 行数、打字机预留高度、CTA 换行和媒体比例；320px 作为最低无溢出检查。

### 13.2 产品能力

- Desktop：12 栏栅格，主面板 7 栏，两个辅助面板在右侧 5 栏内纵向排列。
- Tablet：主面板全宽，辅助面板双列。
- Mobile：严格单列。

### 13.3 快捷指令

- Desktop：截图占 38-42%，条目占 58-62%，列间距 56-64px。
- Tablet：截图在上，条目两列。
- Mobile：截图在上且最大宽度 360px，条目在空间允许时两列；320px 下无法保证可读宽度时允许单列。

### 13.4 使用流程和下载

- Desktop：使用流程三列；下载显示推荐大卡和两个紧凑选项。
- Mobile：全部单列，不使用横向虚线连接。
- 不隐藏电脑端产品画面。

---

## 14. 验收标准

### 14.1 内容和双语

- `/` 首次访问无需 JavaScript 即显示完整英文。
- `/zh-CN/` 首次访问无需 JavaScript 即显示完整中文。
- 两种语言无缺失 key、占位符或混合语言。
- 语言切换保留对应锚点并同步 PWA 语言偏好。
- 英文和中文 CTA 在 320px 以上不换行。
- 所有营销能力描述均能由当前代码、数据库或真实测试支持。

### 14.2 路由和认证

- `/`、`/zh-CN/` 和 `/app` 返回正确 HTML，地址栏保持干净 URL。
- GitHub OAuth、注册确认和密码重置最终回到 `/app`。
- 新安装 PWA 从 `/app` 启动。
- 旧版从 `/` 启动的 standalone PWA 自动迁移到 `/app`。
- 普通浏览器访问 `/` 不被迁移逻辑误跳转。

### 14.3 视觉和交互

- 开发验收允许使用 §16 定义的明确占位素材；公开发布验收必须使用真实产品 poster、产品演示媒体和指令库截图。
- 不出现假设备 mockup、三张等宽功能卡、重复 eyebrow、正文粒子或无意义循环动画。
- Hero 粒子仅在指定区域内运动，不穿过 H1 和 CTA；Reduced Motion 下完全隐藏。
- 320px、375px、768px、960px、1024px、1080px、1440px 无横向溢出和内容遮挡。
- 英文和中文 H1 在 `>= 1080px` 时均不超过两行；字体加载前后 CTA 和媒体不跳动。
- 导航在暗色 Hero 和浅色正文两种状态下均通过文字、图标和 Focus 对比度检查，状态切换不改变高度。
- 导航、语言切换、移动菜单和下载控件均可键盘操作。
- 所有交互有 hover、focus-visible、active 和 disabled 状态。

### 14.4 性能

- Lighthouse Performance >= 90，移动端冷启动测试。
- LCP < 2.5s。
- INP < 200ms。
- CLS < 0.1。
- Hero poster 预留宽高，视频不引起布局移动。
- 打字机容器按当前语言最长文案预留高度，不引起布局移动。
- 非首屏媒体使用懒加载，首屏资源总量在实施计划中设预算。

### 14.5 可访问性

- 正文和按钮达到 WCAG AA。
- Tab 可达所有交互元素，顺序与视觉顺序一致。
- Reduced Motion 下没有自动播放和无限循环。
- 屏幕阅读器不会逐字播报打字动画。
- 移动菜单具备正确的焦点管理和 ARIA 状态。
- 自动化检查和人工键盘走查均通过。

### 14.6 SEO 和发布

- 两种语言的 title、description、canonical、hreflang 和 OG 信息正确。
- sitemap、robots 和 JSON-LD 可访问并通过验证。
- 所有下载按钮来自 `downloads.json`，真实 URL 可用。
- HTML 不包含未替换占位符。
- 官网不引用 manifest，`/app` 正确引用更新后的 manifest。

---

## 15. 实施顺序

1. **迁移保护：** 复制原 `index.html` 为 `app.html`，先修正 manifest、OAuth 回跳和旧 PWA standalone 兼容。
2. **双语构建：** 创建 landing 模板和两个 locale 文件，生成英文根页面和中文页面。
3. **路由：** 按当前 Worker `fetch` 接口增加 `/`、`/zh-CN/` 和 `/app` 精确映射与测试。
4. **真实素材：** 录制并脱敏产品工作流视频，生成 poster 和 OG 图片。
5. **页面骨架：** 实现导航、非对称 Hero、产品能力、快捷指令、使用流程、下载和 Footer。
6. **下载清单：** 从真实构建产物生成 `downloads.json` 并校验 Release URL。
7. **质量层：** 完成响应式、键盘、Reduced Motion、对比度和 SEO。
8. **验收：** 运行构建测试、路由测试、Lighthouse、HTML 验证和四断点视觉走查。

---

## 16. 素材依赖、开发完成与发布门槛

### 16.1 本次开发完成标准（已确认）

**本次开发交付以“占位 + 占位样式完整”作为完成标准。** 真实录屏、截图、OG 图由用户后续替换，不需要在本次实现任务中产出。该标准只代表页面代码和布局完成，不代表官网已经满足公开发布条件。

### 16.2 占位规则

所有媒体位置在素材未准备好时使用明确的占位：

1. **Hero 右侧视频区**：`<video>` 标签预留正确属性，素材未就绪时不输出 `src` 或 `<source>`，`poster` 指向 SVG/PNG 占位图（含“Product demo coming soon”文字 + 播放图标）。
2. **产品能力 section 主面板**：同样预留 `<img>` 或 `<video>` 位置；`img` 指向本地占位图，`video` 在素材未就绪时省略媒体源。
3. **快捷指令 section 左侧截图**：预留 `<img>` 位置并指向本地占位图，占位图含“Preset library screenshot”文字。
4. **OG 分享图**：`og:image` 指向一张通用占位图（`1200x630`，含 VoiceBridge logo + 主色背景）。

### 16.3 占位禁止行为

- 不使用 div + CSS 拼出假的手机/电脑/文档界面冒充真实截图。
- 不使用 AI 生成图像冒充产品截图。
- 不在占位图上使用真实用户数据样例。

### 16.4 公开发布门槛

公开发布前必须补齐：

1. 手机录音到电脑输入框的 8-12 秒脱敏录屏（webm + mp4）。
2. 录屏对应 poster 图。
3. PWA 指令库真实截图。
4. `1200x630` 的英文和中文通用 OG 分享图。

公开版本不得出现 “Product demo coming soon / 产品演示即将上线”、通用截图占位文字或占位 OG 图。若真实视频尚未完成，允许使用真实产品静态截图作为 Hero poster，并暂时改为用户主动播放或纯静态展示，但不得用虚构界面代替。

---

**文档结束。下一步可据此生成详细实施计划。**
