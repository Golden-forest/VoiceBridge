# 网站设计风格 Prompt

设计一个 **温暖、圆润、克制** 的产品宣传官网。

## 整体感觉

- **温暖色调**：不要冷冰冰的蓝紫，用"暖白 + 烧橙"——背景奶油暖白 `#fffbf5`，强调色烧橙渐变 `linear-gradient(135deg, #f97316, #ea580c)`
- **Hero 用深色**：Hero 区用深棕黑 `#0d0a08`（不是纯黑），配柔和的装饰元素（光晕、流动渐变、或慢速粒子），让首屏有质感；后面内容区切回暖白，形成节奏
- **圆润友好**：字体圆润，圆角中等偏大（按钮 10px、卡片 16px、大容器 32px）
- **单一强调色**：全站只用一个橙色作为强调，绝不出现蓝紫

## 字体（最重要）

```
"SF Pro Rounded", "Nunito", "MiSans", "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", sans-serif
```

- 英文：**SF Pro Rounded**（Apple 系统圆润字体），非 Apple 设备回退到 **Nunito**
- 中文：**MiSans** 优先（小米开源圆润字体），回退到 PingFang SC / 微软雅黑
- 加载方式：variable font woff2，字重范围 400-800
- 标题用 700-800 字重，正文 500-600，按钮 700

## 颜色清单

| 用途 | 值 |
|---|---|
| 页面背景 | `#fffbf5`（暖白） |
| 卡片背景 | `#ffffff` |
| Hero/章节深色背景 | `#0d0a08`（带橘调的深棕黑） |
| 主文字 | `#1c1917` |
| 次文字 | `#78716c` |
| 强调色 | `#e8793a` |
| 强调渐变 | `linear-gradient(135deg, #f97316, #ea580c)` |
| 边框 | `rgba(0,0,0,0.06)` |
| 危险色 | `#ef4444` |

## 按钮系统

- **Primary**：橙色渐变背景 + 白字 + 10px 圆角 + `padding: 14px 28px` + 字重 700
- **Secondary**：透明背景 + 1px 边框 + 主文字色 + 10px 圆角
- 所有按钮 hover 用轻微位移（`translateY(-1px)`）+ 阴影增强，**不要用颜色突变**

## 卡片

- 白底 `#ffffff`
- 边框 `1px solid rgba(0,0,0,0.06)`
- 圆角 16px
- padding 32px
- hover：阴影 `0 12px 32px rgba(200,120,50,0.12)` + 轻微上移

## Section 节奏

每个内容 section 用一个小标签开头（如 "SECTION 01"，全大写、字距 0.1em、橙色），下面接一个大标题（H2，字重 800）+ 一句副标题。然后是栅格内容。

section 之间纵向间距至少 96px。

## 图标

用 SVG 内联，Feather/Lucide 风格：
- `fill="none"`
- `stroke="currentColor"`
- `stroke-width="2"`
- `stroke-linecap="round"`
- `stroke-linejoin="round"`

## 动效

- 缓动：`cubic-bezier(0.4, 0, 0.2, 1)`（标准）/ `cubic-bezier(0.34, 1.56, 0.64, 1)`（弹性）
- hover transition：200-300ms
- **克制**：不要每个 section 都加 scroll fade-in 动画。内容默认可见，只在 Hero 用一两个重点装饰（如光晕、慢粒子、渐变流动）
- 永远尊重 `prefers-reduced-motion`

## 文案调性

- **英文**：专业但不冷漠，用短句、动词开头。例：用一句主标题点明价值主张（不超过 8 个词）+ 一句副标题展开说明
- **中文**：亲切但简洁，避免营销大词。例：用 6-12 字的主标题 + 一句完整的副标题
- CTA 用动词：Get Started / Try Free / Download，避免 "Learn More" 这种被动表达

## 不要做（Don't）

- ❌ 蓝紫色调（这是最容易出 AI 味的反模式）
- ❌ 全局 dark mode 切换（用章节级明暗节奏，不要整页变暗）
- ❌ 对称 50/50 栅格（用 40/60 或 60/40 这种不对称更有设计感）
- ❌ 太多的 scroll reveal 动画
- ❌ 系统默认无衬线字体（Inter / Roboto / Helvetica 单独使用）—— 必须圆润
- ❌ emoji 当图标用
- ❌ glassmorphism（玻璃拟态）过度模糊

## 参考文件路径

完整设计源码（如需查阅具体实现细节）：
- `hosted-pwa/public/landing.css` — 设计 token（颜色/字体/圆角/阴影）+ 所有视觉组件
- `hosted-pwa/landing/template.html` — 官网 DOM 结构、SVG 图标写法、section 划分
- `hosted-pwa/public/landing.js` — Hero 轮播、动效
