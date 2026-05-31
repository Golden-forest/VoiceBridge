# VoiceBridge 全面巡检修复计划

日期: 2026-05-31
状态: 进行中

## 已修复 (低成本高收益)

### 服务端安全 (9 项)
- [x] **C3** Host Header 校验 -- 防止开放重定向 (index.js)
- [x] **H8** WebSocket catch 块添加 console.error (ws.js)
- [x] **方向白名单** WebSocket arrow 消息只允许 up/down/left/right (ws.js)
- [x] **H4** PUT /api/commands/:id 字段白名单 (commands.js)
- [x] **M2** readCommandsFile 区分 ENOENT 与其他错误 (commands.js)
- [x] **M3** ensureCommandsFile 只在数据变更时写文件 (commands.js)
- [x] **方向白名单** paste.js pressArrow 函数 (paste.js)
- [x] **M11** process unhandledRejection/uncaughtException 处理 (index.js)
- [x] **AppleScript 消毒** appName/windowTitle 去换行+长度限制 (windowManager.js)

### ASR 可靠性 (4 项)
- [x] **H1** 腾讯云 API 30 秒超时 (AbortController) (tencentCloudTranscriber.js)
- [x] **H2** 重试机制: 2 次重试，指数退避，仅重试网络错误/5xx (tencentCloudTranscriber.js)
- [x] **M10** ffmpeg 进程 30 秒超时 (audioConverter.js)
- [x] **M2(ASR)** Result 类型安全检查 (tencentCloudTranscriber.js)

### 前端 (4 项)
- [x] **C4** lastAutoPastedText 5 秒超时自动清除 (app.js)
- [x] **H9** 文本输入 2000 字符实际限制 (app.js)
- [x] **M7** 所有 fetch 调用添加 res.ok 检查 (app.js, 6 处)
- [x] **M6** _saveSelection 添加 try-catch (app.js)

## 待讨论 (需要澄清/决策)

### CRITICAL -- PIN 认证机制
**问题**: 零认证，同 WiFi 任何人可控制电脑键盘/剪贴板
**需讨论**:
- 认证方案: PIN 码 / TLS 客户端证书 / OAuth token?
- PIN 码 UX: 终端显示 + 前端输入框? 还是 URL 中带 token?
- PIN 码生命周期: 每次启动重新生成? 还是持久化可配置?
- 是否需要多设备支持?

### HIGH -- 命令库文件锁
**问题**: 并发读写 commands.json 导致数据丢失
**需讨论**:
- 方案: proper-lockfile? 还是 write-to-temp-then-rename?
- 是否需要引入 SQLite/IndexedDB 替代 JSON 文件?
- 当前用户量下实际并发概率极低，优先级如何?

### MEDIUM -- CORS / Rate Limiting
**需讨论**:
- CORS 策略: 因为是同源 HTTPS 服务，是否真的需要?
- Rate Limiting: 仅对 /api/upload 限流? 使用 express-rate-limit?

### LOW -- Service Worker / PWA 完善
**需讨论**:
- 是否需要离线功能? (核心依赖服务端 WebSocket)
- manifest.json 补全 (scope, maskable icons) 是否值得做?

## 未修复但明确 (后续按需处理)

### 剩余 HIGH
- [ ] **H5** 剪贴板写入与粘贴间竞态 (outputText.js 120ms 硬编码延迟)
- [ ] **H6** paste.js osascript 无超时 (辅助功能弹窗阻塞)
- [ ] **H7** 文件上传无 MIME 类型验证 (upload.js)
- [ ] **H10** 大文件全量读入内存 (tencentCloudTranscriber.js)

### 剩余 MEDIUM
- [ ] **M1** 无 CORS / Rate Limiting
- [ ] **M4** execSync 生成证书阻塞 (certs.js)
- [ ] **M5** 临时文件崩溃残留无清理
- [ ] **M6(ws)** WebSocket 无 maxPayload 限制
- [ ] **M8** 暗色模式部分 UI 未覆盖
- [ ] **M9** lastUsedAt 类型不一致
- [ ] **M11** commands.js 错误响应泄露内部信息

### 剩余 LOW
- [ ] **L1** 文件名用 Math.random() 而非 crypto.randomUUID()
- [ ] **L2** broadcast 无背压处理
- [ ] **L4** WebSocket 重连无 visibilitychange 快速恢复
- [ ] **L5** PWA 无 Service Worker
- [ ] **L6** manifest.json 缺少 scope/maskable
- [ ] **L7** 无障碍访问缺失
- [ ] **L8** 测试覆盖严重不足 (upload/commands 路由、前端无测试)
- [ ] **L9** 命令库迁移逻辑串行执行
- [ ] **L10** 87KB base64 内联 apple-touch-icon
