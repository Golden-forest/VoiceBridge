# SaaS 前端产品化体验补齐设计

> 分支：`codex/saas-auth-v3`
> 日期：2026-06-09
> 状态：Draft

## 背景

SaaS 云模式的后端核心链路已全部打通（Supabase Auth、Stripe Checkout/Portal/Webhook、转写额度拦截），但前端缺少产品化体验。用户看不到定价对比、不知道自己的订阅状态和剩余额度、支付后无反馈、无法重置密码。

本设计一次性补齐 9 项前端功能，复用现有 UI 模式和 CSS 变量体系。

## 设计原则

- **复用现有模式**：弹窗/抽屉复用 `.add-cmd-dialog` 的底部抽屉结构，Toast 复用 `showToast()`，显隐复用 `.hidden` class
- **统一视觉风格**：所有新 UI 严格使用现有 CSS 变量（`--accent`、`--bg-card`、`--radius-md` 等），遵循大圆角 + 暖色阴影风格
- **仅 Cloud 模式生效**：所有新增功能仅在 `isCloudMode && session` 时渲染，local 模式不显示
- **最小改动**：不引入路由系统，不重构现有组件，仅在现有文件上追加

## 一、账户设置底部抽屉（承载核心功能）

### 1.1 入口

头部 `#billingActions` 区域改造。当前只有一个"升级 Pro"按钮，改造为：

```
[Plan Badge: "Free" / "Pro"] [设置图标按钮]
```

- **Plan Badge**：`.status-badge` 样式，Free 为默认色，Pro 为 `--accent` 背景
- **设置图标按钮**：点击打开账户设置抽屉，使用 SVG 齿轮图标

未登录时，Plan Badge 隐藏，只显示登录入口（现有逻辑不变）。

### 1.2 抽屉结构

复用 `.add-cmd-dialog` / `.add-cmd-sheet` 的底部抽屉模式，新增 HTML 结构：

```html
<div id="accountDrawer" class="account-drawer hidden">
  <div class="account-drawer-overlay"></div>
  <div class="account-drawer-sheet">
    <div class="account-drawer-handle"></div>       <!-- 拖拽把手 -->
    <div class="account-drawer-header">              <!-- 标题 + 关闭按钮 -->
      <h2>账户设置</h2>
      <button class="account-drawer-close">✕</button>
    </div>
    <div class="account-drawer-body">                <!-- 滚动内容区 -->
      <!-- 2. Plan 与额度 -->
      <!-- 3. 定价对比 -->
      <!-- 4. 用量统计 -->
      <!-- 5. 订阅管理 -->
      <!-- 6. 个人资料 -->
      <!-- 7. 设备管理 -->
    </div>
  </div>
</div>
```

CSS 样式直接复用 `.add-cmd-overlay`、`.add-cmd-sheet`、`.add-cmd-handle` 的视觉模式（`backdrop-filter: blur(4px)`、`border-radius: 22px 22px 0 0`、`max-width: 430px`）。

### 1.3 交互

- 点击设置图标 → `.hidden` 移除 → 抽屉从底部滑入
- 点击遮罩 / 关闭按钮 / Escape → `.hidden` 添加 → 抽屉关闭
- 无拖拽功能（保持简单），仅视觉把手

---

## 二、Plan 状态与剩余额度展示

### 2.1 位置

抽屉 body 顶部，第一个 section。

### 2.2 UI

```
┌─────────────────────────────┐
│  当前方案                     │
│  ┌───────────────────────┐   │
│  │  Pro          ✓ 有效  │   │  ← status-badge + accent 背景
│  └───────────────────────┘   │
│  本月额度                      │
│  已用 2340 秒 / 18000 秒      │
│  ████████████░░░░░░░░  13%   │  ← 进度条
│  速率 8/30 次·分               │
└─────────────────────────────┘
```

### 2.3 数据来源

- 查询 `subscriptions` 表获取 `plan`、`status`、`current_period_end`
- 查询 `usage_events` 表聚合本月 `SUM(claim_seconds)` where `status='success'`
- `planLimits.js` 中的 `MONTHLY_SECONDS` / `RATE_LIMIT` 常量用于计算百分比

### 2.4 CSS

- 进度条：`.usage-bar` — 高度 8px、圆角 999px、`--bg-soft` 底色、`--accent` 填充
- 百分比文字：`--text-secondary` 色
- 速率文字：`--text-muted` 色

---

## 三、定价对比（Free vs Pro）

### 3.1 位置

抽屉 body，plan 状态下方。

### 3.2 UI

```
┌─────────────────────────────┐
│  方案对比                     │
│  ┌──────────┐ ┌──────────┐  │
│  │  Free    │ │  Pro ✓   │  │  ← 右侧卡片有 accent 边框
│  │          │ │          │  │
│  │  600秒/月│ │ 18000秒/月│  │
│  │  60秒/次 │ │  60秒/次  │  │
│  │  10次/分 │ │  30次/分  │  │
│  │          │ │          │  │
│  │   —     │ │  升级 Pro │  │  ← accent-gradient 按钮
│  └──────────┘ └──────────┘  │
└─────────────────────────────┘
```

### 3.3 交互

- 已是 Pro 用户：Pro 卡片显示"当前方案"，隐藏"升级"按钮
- Free 用户点击"升级 Pro"→ 调用现有 `openBillingSession('checkout')`
- 无订阅（未创建 Stripe Customer）：显示"免费试用"文案

---

## 四、用量仪表板

### 4.1 位置

定价对比下方，与定价共用一个滚动区域。

### 4.2 UI

```
┌─────────────────────────────┐
│  用量明细                     │
│  2026年6月                    │  ← 当前月份
│                              │
│  总转写时长     2,340 秒      │
│  转写次数         38 次        │
│  成功率          95%          │
│  拒绝次数          2 次        │
└─────────────────────────────┘
```

### 4.3 数据来源

- `usage_events` 表：`count(*)`、`SUM(claim_seconds)` 按 `status` 分组
- `subscriptions.current_period_start` ~ `current_period_end` 作为时间范围

---

## 五、订阅管理

### 5.1 位置

用量仪表板下方。

### 5.2 UI

```
┌─────────────────────────────┐
│  订阅管理                     │
│                              │
│  状态          有效          │  ← status-badge
│  当前周期  6/1 - 6/30        │
│  下次续费  按月订阅          │
│                              │
│  [管理订阅]  (→ Stripe Portal)│  ← billing-button 样式
└─────────────────────────────┘
```

- `cancel_at_period_end = true` 时显示"将于 6/30 到期"黄色提示
- Free 用户只显示"暂无订阅"

---

## 六、个人资料（Profile）

### 6.1 位置

订阅管理下方。

### 6.2 UI

```
┌─────────────────────────────┐
│  个人资料                     │
│                              │
│  邮箱    u***@gmail.com       │  ← 脱敏显示
│  [修改邮箱]                   │  ← billing-button 样式
│                              │
│  密码    ••••••               │
│  [修改密码]                   │  ← billing-button 样式
│                              │
│  [退出登录]                   │  ← 红色文字按钮
└─────────────────────────────┘
```

### 6.3 交互

- **修改邮箱**：点击后切换为 inline 输入框 + 确认/取消按钮。调用 `supabase.auth.updateUser({ email })`
- **修改密码**：点击后弹出 inline 表单（当前密码 + 新密码）。调用 `supabase.auth.updateUser({ password })`
- **退出登录**：调用现有 `VoiceBridgeAuth.signOut()`，关闭抽屉

---

## 七、设备管理

### 7.1 位置

抽屉最底部。

### 7.2 UI

```
┌─────────────────────────────┐
│  已连接设备                   │
│                              │
│  ● MacBook Pro   刚刚活跃    │  ← 绿点 + 设备名 + 最后活跃
│    [移除]                    │  ← 小文字按钮
│                              │
│  ● iPhone 15     3分钟前     │
│    [移除]                    │
│                              │
│  ○ iPad Air     2天前        │  ← 灰点 = 离线
│    [移除]                    │
└─────────────────────────────┘
```

### 7.3 数据来源

- 查询 `devices` 表：`device_name`、`last_seen_at`、`platform`
- 按 `last_seen_at` 降序排列

### 7.4 交互

- **移除设备**：调用 `supabase.from('devices').delete().eq('id', deviceId)`
- 不允许移除当前设备（当前 session 对应的设备）

---

## 八、Auth Overlay 增强

### 8.1 密码重置

在 auth-card 的登录表单中，密码输入框下方添加"忘记密码？"文字链接：

```
┌─────────────────────────┐
│  VoiceBridge             │
│                          │
│  邮箱     [___________] │
│  密码     [___________] │
│  忘记密码？              │  ← 新增，text-secondary 色
│  [登录]                  │
│                          │
│  没有账号？立即注册      │
└─────────────────────────┘
```

点击后：
1. 表单切换为重置模式（邮箱输入 + "发送重置链接"按钮 + "返回登录"链接）
2. 调用 `supabase.auth.resetPasswordForEmail(email)`
3. 成功后显示 Toast："重置链接已发送到您的邮箱"

### 8.2 Token 过期提示

在 `handleAuthState()` 中，当 session 从有效变为 null 且不是主动注销时：

```js
authMessage.textContent = "会话已过期，请重新登录";
```

### 8.3 邮箱验证重发

注册成功后，auth-card 切换为验证等待态：

```
┌─────────────────────────┐
│  VoiceBridge             │
│                          │
│  注册成功！              │
│  请检查邮箱完成验证       │
│                          │
│  [重新发送验证邮件]       │  ← billing-button 样式
│                          │
│  [返回登录]              │
└─────────────────────────┘
```

调用 `supabase.auth.resend({ type: 'signup', email })`

---

## 九、Stripe 支付回调处理

### 9.1 位置

`app.js` 初始化阶段。

### 9.2 逻辑

```js
const params = new URLSearchParams(location.search);
const billing = params.get("billing");
if (billing === "success") {
  showToast("订阅成功，欢迎使用 Pro 方案");
  history.replaceState(null, "", location.pathname);  // 清除 URL 参数
} else if (billing === "cancel") {
  showToast("订阅已取消");
  history.replaceState(null, "", location.pathname);
}
```

使用现有 `showToast()` 函数，不引入新 UI 组件。

---

## 文件改动范围

| 文件 | 改动内容 |
|------|---------|
| `src/public/index.html` | 新增 `#accountDrawer` HTML 结构、auth-card 新增忘记密码链接和重置表单、邮箱验证重发按钮 |
| `src/public/style.css` | 新增抽屉样式（`.account-drawer-*`）、plan badge、进度条（`.usage-bar`）、定价对比卡片、profile/device 列表项样式 |
| `src/public/app.js` | 新增 `AccountDrawer` 类（open/close/render）、`billing=success/cancel` 参数处理、`handleAuthState` 增强（token 过期提示）、auth 表单状态切换逻辑、密码重置流程、邮箱重发流程 |
| `src/public/auth.js` | 新增 `resetPassword(email)` 和 `resendVerification(email)` 方法暴露到 `VoiceBridgeAuth` |

不需要改动后端文件或新增文件。
