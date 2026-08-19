// 简体中文语言包（基准语言，key 缺失时永远 fallback 到这里）
export default {
  // === 通用 ===
  common: {
    save: '保存',
    cancel: '取消',
    delete: '删除',
    confirm: '确认',
    refresh: '刷新',
    loading: '加载中…',
    search: '搜索',
    close: '关闭',
    remove: '移除',
    confirmQuestion: '确认？',
    copyToPhone: '复制到手机',
    copied: '已复制',
    newCategory: '新分类…',
  },

  // === 顶栏 / 品牌 ===
  header: {
    account: '账户',
    accountSettings: '账户设置',
    refresh: '刷新',
  },

  // === 目标窗口 / 设备 pill ===
  device: {
    targetWindow: '目标窗口',
    connecting: '正在连接',
    connectionState: '连接状态',
    statusConnected: '已连接',
    statusDisconnected: '未连接',
    statusConnecting: '连接中',
    autoPaste: '自动粘贴',
    device: '设备',
    waitingDesktop: '等待桌面端上线',
    cursorPosition: '光标位置',
  },

  // === 局域网页面模式 ===
  lan: {
    channelCloud: '云端',
    channelLanAvailable: '局域网可用',
    channelLan: '局域网',
    switchToLan: '切换到局域网模式，速度更快',
    backToCloud: '返回云端模式',
    pairTitle: '局域网配对',
    pairHint: '输入电脑端 VoiceBridge 显示的配对码，连接本机局域网服务。',
    pairCodePlaceholder: '配对码',
    pairSubmit: '配对',
    pairFailed: '配对码错误，请检查后重试。',
    pairSuccess: '配对成功，正在刷新…',
    lanLost: '局域网连接已断开，正在返回云端…',
  },

  // === 文本输入 ===
  input: {
    editLabelPlaceholder: '按钮显示名称…',
    editLabelAria: '编辑指令名称',
    placeholder: '输入文字，或语音识别…',
    textInputAria: '文字输入',
    savePhrase: '收藏',
    sendToDesktop: '发送',
    charCount: (cur, max) => `${cur}/${max}`,
    textTooLong: '文本过长，最多支持 2000 个字符',
    autoSentNotice: '该文本已通过语音自动发送。',
  },

  // === 主操作按钮 ===
  actions: {
    paste: '粘贴',
    record: '录音',
    enter: '回车',
    esc: 'Esc',
    delete: '删除',
    undo: '撤销',
    fallbackUpload: '录音或选择音频上传',
  },

  // === 指令库 ===
  library: {
    panelAria: '指令库',
    searchPlaceholder: '搜索指令…',
    searchAria: '搜索指令',
    empty: '指令库为空',
    noMatch: '没有匹配的指令',
    lockedTip: '升级 Pro 后可使用这条指令。',
    lockedTooltip: '升级 Pro 后可用',
    loadFailed: '加载指令失败',
    saved: '已保存指令。',
    deleted: '已删除指令。',
    deleteFailed: '删除失败。',
    addTitle: '新增指令',
    addContentLabel: '指令内容',
    addContentPlaceholder: '输入指令内容…',
    addCategoryLabel: '分类',
    addNewCategoryPlaceholder: '输入新分类名称…',
    categoryGeneral: '通用',
  },

  // === 状态 / Toast ===
  status: {
    sentToDesktop: '已发送到电脑。',
    desktopNotOpen: '请先打开桌面客户端。',
    sending: '已发送，等待桌面端确认...',
    sendFailed: '发送失败，请稍后重试。',
    sendFailedConnection: '发送失败，请检查连接。',
    sessionExpired: '会话已过期，请重新登录',
    sentToDesktopAck: '已发送到桌面端。',
    desktopExecFailed: (detail) => `桌面端执行失败：${detail}`,
    protocolTooOld: '电脑客户端版本过旧，请重新打开最新的 VoiceBridge Agent。',
  },

  // === 录音 / 转写 ===
  record: {
    recordUnsupported: '当前浏览器无法直接录音，可改用音频上传兜底。',
    reachedLimit: (seconds) => `已到 ${seconds} 秒上限，正在上传音频...`,
    maxDurationHint: (seconds) => `本次最多录制 ${seconds} 秒。`,
    micDenied: (msg) => `无法访问麦克风：${msg}`,
    uploading: '正在上传音频...',
    noVoice: '没有录到声音，请再试一次。',
    recognizing: '正在识别...',
    appendedToBuffer: '已加入输入缓冲。',
    voiceCommandExecuted: '已执行语音命令。',
    voiceCommandFailed: '语音命令执行失败。',
    copiedAndPasted: '已复制并自动粘贴。',
    copiedToClipboard: '已复制到电脑剪切板。',
    copiedToClipboardShort: '已复制到剪切板。',
    clipboardFailed: '识别成功，但写入剪切板失败。',
    pasteAutoFailed: '已复制，自动粘贴失败。',
    noTranscriptText: '识别完成，但没有返回可用文字。',
    recordingFailed: '录音停止失败，请重试。',
    stopFailed: '录音处理失败，请重试。',
    uploadTimeout: '上传超时，请检查网络连接',
    uploadFailed: '上传失败',
    recording: '正在录音…',
    recordLabel: '录音',
    stopLabel: '停止',
    pasteKeySuccess: '已粘贴。',
    enterKeySuccess: '已按回车。',
    escKeySuccess: '已按 Esc。',
    deleteKeySuccess: '已按删除。',
    undoKeySuccess: '已撤销。',
    quickCmdSent: '已发送快捷指令。',
  },

  // === 订阅 / Billing ===
  billing: {
    subscribeSuccess: '订阅成功，欢迎使用 Pro 方案',
    subscribeCanceled: '订阅已取消',
    subscriptionRequestFailed: '订阅请求失败，请稍后重试。',
    activating: '支付已收到，正在激活 Pro…',
    activatingTimeout: '激活时间较长，请稍后刷新页面查看。',
  },

  // === 窗口选择器 ===
  windowSelector: {
    fetchFailed: '获取窗口失败',
    noWindows: '没有找到可输入的窗口',
    noWindowsReported: '桌面端未上报窗口',
    defaultWindowName: '窗口',
    cursorPosition: '光标位置',
  },

  // === WebSocket / Cloud 连接状态 ===
  connection: {
    wsConnected: '已连接电脑端',
    cloudConnected: '云端已连接',
    cloudConnectFailed: '云端连接失败',
    cloudConnectFailedToast: '云端连接失败，请稍后重试。',
    reconnecting: '连接已断开，正在重连…',
    sendFailed: '发送失败，请稍后重试。',
  },

  // === 指令库编辑提示（扩展） ===
  libraryExtra: {
    lockedEdit: '升级 Pro 后可编辑这条指令。',
    presetNonEditable: '系统预置指令不可编辑。',
    editPlaceholder: '编辑指令内容…',
    addedSuccess: '已添加指令。',
    addFailed: '添加失败。',
    needUpdate: (name) => `${name}（需更新）`,
    recent: '最近',
    uncategorized: '未分类',
  },

  // === 设备状态后缀 ===
  planBadge: {
    admin: '超级管理员',
    pro: 'Pro',
    free: 'Free',
  },

  // === 账户抽屉 ===
  account: {
    title: '账户设置',
    loadFailed: '加载失败',
    pleaseLogin: '请先登录',
    getSubFailed: '获取订阅信息失败',
    getUsageFailed: '获取用量信息失败',
    getDevicesFailed: '获取设备信息失败',

    // 当前方案
    currentPlan: '当前方案',
    adminLabel: '超级管理员',
    planPro: 'Pro',
    planFree: 'Free',
    usedMonthlyQuota: '已用 / 月额度',
    unlimitedSeconds: (sec) => `${sec.toLocaleString()} 秒 (∞ 无限制)`,
    usedSecondsOfLimit: (sec, max, pct) => `${sec.toLocaleString()} / ${max.toLocaleString()} 秒 (${pct}%)`,

    // 方案对比
    pricingTitle: '方案对比',
    monthlyQuota: '月额度',
    maxPerAudio: '单次最长',
    rateLimitPerMin: '速率(次/分)',
    secondsUnit: (sec) => `${sec}秒`,
    upgradeToPro: '升级 Pro',
    currentPlanBadge: '当前方案',

    // 用量明细
    usageTitle: '用量明细',
    totalDuration: '总转写时长',
    totalTranscriptions: '转写次数',
    successRate: '成功率',
    rejectedCount: '拒绝次数',
    secondsValue: (sec) => `${sec.toLocaleString()} 秒`,
    timesValue: (n) => `${n} 次`,

    // 订阅管理
    subscriptionTitle: '订阅管理',
    noSubscription: '暂无订阅',
    statusLabel: '状态',
    statusActive: '有效',
    statusTrialing: '试用中',
    statusPastDue: '逾期',
    statusCanceled: '已取消',
    statusUnpaid: '未支付',
    currentPeriod: '当前周期',
    periodRange: (start, end) => `${start} - ${end}`,
    willExpireOn: (date) => `将于 ${date} 到期`,
    manageSubscription: '管理订阅',

    // 个人资料
    profileTitle: '个人资料',
    emailLabel: '邮箱',
    desktopPassword: '桌面登录密码',
    passwordSet: '已设置',
    passwordUnset: '未设置',
    editEmail: '修改邮箱',
    setPassword: '设置桌面登录密码',
    changePassword: '修改密码',
    newEmailPlaceholder: '新邮箱',
    newPasswordPlaceholder: '新密码（至少6位）',
    confirmPasswordPlaceholder: '再次输入新密码',
    emailUpdateSent: '验证邮件已发送到新邮箱',
    passwordSetSuccess: '桌面登录密码已设置，可在电脑端使用',
    passwordTooShort: '新密码至少需要6位',
    passwordMismatch: '两次输入的密码不一致',
    modifyFailed: '修改失败',

    // 设备
    devicesTitle: '已连接设备',
    noDevices: '暂无已注册设备',
    unknownDevice: '未知设备',
    unknown: '未知',
    removeFailed: '移除失败',

    // 退出登录
    logout: '退出登录',

    // 语言（自引用 - 自身切换）
    languageTitle: '语言',
    languageZhCN: '简体中文',
    languageEn: 'English',
  },

  // === Auth Overlay ===
  auth: {
    eyebrow: 'VOICE TO ANY TEXT FIELD',
    subtitleLogin: '登录后，手机录音会自动出现在电脑光标处',
    subtitleSignup: '创建免费账号，在任意网络连接手机和电脑',
    emailLabel: '邮箱',
    passwordLabel: '密码',
    forgotPassword: '忘记密码？',
    passwordPlaceholder: '至少 6 位',
    submitLogin: '登录',
    submitSignup: '注册账号',
    switchToSignup: '没有账号？创建账号',
    switchToLogin: '已有账号？返回登录',
    orDivider: '或者',
    githubButton: '使用 GitHub 注册或登录',
    resendVerification: '重新发送验证邮件',
    resetPasswordTitle: '重置密码',
    resetPasswordCopy: '输入注册邮箱，我们会把重置链接发送给你。',
    sendResetLink: '发送重置链接',
    backToLogin: '返回登录',
    backToReset: '找回你的 VoiceBridge 账号',
    footnote: '手机和电脑无需连接同一个网络',
    missingConfig: '缺少 Supabase 配置，请检查 /config.js。',
    signupSuccess: '注册成功，请检查邮箱完成验证。',
    authRequestFailed: '认证请求失败，请稍后再试。',
    githubFailed: 'GitHub 登录失败，请稍后再试。',
    resetSent: '重置链接已发送到您的邮箱。',
    resetSentShort: '已发送',
    resetSendFailed: '发送失败，请稍后重试。',
  },

  // === 配对 Overlay ===
  pairing: {
    defaultDeviceName: 'VoiceBridge 电脑',
    secureTitle: '安全连接请求',
    bindDesktop: '绑定这台电脑',
    description: '允许后，手机转写结果会加密发送到这台电脑，并自动粘贴到当前光标处。',
    confirm: '允许并绑定',
    cancel: '暂不绑定',
    binding: '正在安全绑定…',
    sessionExpired: '登录状态已失效，请重新登录。',
    bindFailedRefresh: '绑定失败，请刷新电脑二维码后重试。',
    bound: (name) => `已绑定 ${name}，电脑将自动上线。`,
    success: '绑定成功',
    failed: '绑定失败，请稍后重试。',
  },

  // === 命令 Store ===
  commandStore: {
    loginRequired: '请先登录后再使用指令库。',
    fetchPersonalFailed: '获取个人指令失败。',
    fetchPresetFailed: '获取预置指令失败。',
    missingFields: '缺少 text, label 或 category 字段',
    saveFailed: '保存指令失败。',
    missingId: '缺少指令 id',
    nothingToUpdate: '没有可更新的字段。',
    updateFailed: '更新指令失败。',
    notExist: '指令不存在。',
    deleteFailed: '删除指令失败。',
    operationFailed: '指令操作失败。',
  },

  // === 时间格式化 ===
  time: {
    justNow: '刚刚',
    minutesAgo: (n) => `${n}分钟前`,
    hoursAgo: (n) => `${n}小时前`,
    daysAgo: (n) => `${n}天前`,
    monthsAgo: (n) => `${n}个月前`,
  },

  // === 底部法律链接 ===
  footer: {
    privacy: '隐私政策',
    terms: '用户协议',
    faq: '常见问题',
  },
};
