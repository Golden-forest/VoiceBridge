// English language pack
export default {
  // === Common ===
  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    confirm: 'Confirm',
    refresh: 'Refresh',
    loading: 'Loading…',
    search: 'Search',
    close: 'Close',
    remove: 'Remove',
    confirmQuestion: 'Confirm?',
    copyToPhone: 'Copy to phone',
    copied: 'Copied',
    newCategory: 'New category…',
  },

  // === Header / Brand ===
  header: {
    account: 'Account',
    accountSettings: 'Account settings',
    refresh: 'Refresh',
  },

  // === Device / Window pill ===
  device: {
    targetWindow: 'Target window',
    connecting: 'Connecting…',
    connectionState: 'Connection status',
    statusConnected: 'Connected',
    statusDisconnected: 'Offline',
    statusConnecting: 'Connecting…',
    autoPaste: 'Auto-paste',
    device: 'Device',
    waitingDesktop: 'Waiting for desktop',
    cursorPosition: 'Cursor position',
  },

  // === LAN page mode ===
  lan: {
    channelCloud: 'Cloud',
    channelLanAvailable: 'LAN available',
    channelLan: 'LAN',
    switchToLan: 'Switch to LAN mode for lower latency',
    backToCloud: 'Back to cloud mode',
    pairTitle: 'LAN pairing',
    pairHint: 'Enter the pairing code shown in VoiceBridge on your computer.',
    pairCodePlaceholder: 'Pairing code',
    pairSubmit: 'Pair',
    pairFailed: 'Incorrect pairing code, please try again.',
    pairSuccess: 'Paired, refreshing…',
    lanLost: 'LAN connection lost, returning to cloud…',
  },

  // === Text input ===
  input: {
    editLabelPlaceholder: 'Button display name…',
    editLabelAria: 'Edit command name',
    placeholder: 'Type, or use voice…',
    textInputAria: 'Text input',
    savePhrase: 'Favorite',
    sendToDesktop: 'Send',
    charCount: (cur, max) => `${cur}/${max}`,
    textTooLong: 'Text too long, max 2000 characters',
    autoSentNotice: 'This text was already auto-sent via voice.',
  },

  // === Main actions ===
  actions: {
    paste: 'Paste',
    record: 'Record',
    enter: 'Enter',
    esc: 'Esc',
    delete: 'Delete',
    undo: 'Undo',
    fallbackUpload: 'Record or choose audio to upload',
  },

  // === Command library ===
  library: {
    panelAria: 'Command library',
    searchPlaceholder: 'Search commands…',
    searchAria: 'Search commands',
    empty: 'Library is empty',
    noMatch: 'No matching commands',
    lockedTip: 'Upgrade to Pro to use this command.',
    lockedTooltip: 'Pro only',
    loadFailed: 'Failed to load commands',
    saved: 'Command saved.',
    deleted: 'Command deleted.',
    deleteFailed: 'Delete failed.',
    addTitle: 'New command',
    addContentLabel: 'Command content',
    addContentPlaceholder: 'Enter command content…',
    addCategoryLabel: 'Category',
    addNewCategoryPlaceholder: 'Enter new category name…',
    categoryGeneral: 'General',
  },

  // === Status / Toast ===
  status: {
    sentToDesktop: 'Sent to desktop.',
    desktopNotOpen: 'Please open the desktop app first.',
    sending: 'Sent, waiting for desktop confirmation…',
    sendFailed: 'Send failed, please retry.',
    sendFailedConnection: 'Send failed, check connection.',
    sessionExpired: 'Session expired, please sign in again',
    sentToDesktopAck: 'Sent to desktop.',
    desktopExecFailed: (detail) => `Desktop execution failed: ${detail}`,
    protocolTooOld: 'Desktop client is outdated, please reopen the latest VoiceBridge Agent.',
  },

  // === Recording / Transcription ===
  record: {
    recordUnsupported: 'Recording is not supported in this browser, use audio upload fallback.',
    reachedLimit: (seconds) => `Reached the ${seconds}-second limit, uploading audio…`,
    maxDurationHint: (seconds) => `You can record up to ${seconds} seconds this time.`,
    micDenied: (msg) => `Microphone unavailable: ${msg}`,
    uploading: 'Uploading audio…',
    noVoice: 'No voice detected, please try again.',
    recognizing: 'Recognizing…',
    appendedToBuffer: 'Added to input buffer.',
    voiceCommandExecuted: 'Voice command executed.',
    voiceCommandFailed: 'Voice command execution failed.',
    copiedAndPasted: 'Copied and pasted automatically.',
    copiedToClipboard: 'Copied to desktop clipboard.',
    copiedToClipboardShort: 'Copied to clipboard.',
    clipboardFailed: 'Recognition succeeded, but clipboard write failed.',
    pasteAutoFailed: 'Copied, auto-paste failed.',
    noTranscriptText: 'Recognition complete, but no usable text returned.',
    recordingFailed: 'Failed to stop recording, please retry.',
    stopFailed: 'Recording processing failed, please retry.',
    uploadTimeout: 'Upload timed out, please check your network',
    uploadFailed: 'Upload failed',
    recording: 'Recording…',
    recordLabel: 'Record',
    stopLabel: 'Stop',
    pasteKeySuccess: 'Pasted.',
    enterKeySuccess: 'Enter pressed.',
    escKeySuccess: 'Esc pressed.',
    deleteKeySuccess: 'Delete pressed.',
    undoKeySuccess: 'Undo pressed.',
    quickCmdSent: 'Quick command sent.',
  },

  // === Billing ===
  billing: {
    subscribeSuccess: 'Subscription active, welcome to Pro!',
    subscribeCanceled: 'Subscription canceled',
    subscriptionRequestFailed: 'Subscription request failed, please retry.',
    activating: 'Payment received. Activating Pro…',
    activatingTimeout: 'Activation is taking longer than expected. Please refresh in a moment.',
  },

  // === Window selector ===
  windowSelector: {
    fetchFailed: 'Failed to fetch windows',
    noWindows: 'No windows available for input',
    noWindowsReported: 'Desktop reported no windows',
    defaultWindowName: 'Window',
    cursorPosition: 'Cursor position',
  },

  // === WebSocket / Cloud connection status ===
  connection: {
    wsConnected: 'Connected to desktop',
    cloudConnected: 'Cloud connected',
    cloudConnectFailed: 'Cloud connection failed',
    cloudConnectFailedToast: 'Cloud connection failed, please retry.',
    reconnecting: 'Disconnected, reconnecting…',
    sendFailed: 'Send failed, please retry.',
  },

  // === Library edit hints (extended) ===
  libraryExtra: {
    lockedEdit: 'Upgrade to Pro to edit this command.',
    presetNonEditable: 'System preset command cannot be edited.',
    editPlaceholder: 'Edit command content…',
    addedSuccess: 'Command added.',
    addFailed: 'Add failed.',
    needUpdate: (name) => `${name} (update needed)`,
    recent: 'Recent',
    uncategorized: 'Uncategorized',
  },

  // === Plan badge labels ===
  planBadge: {
    admin: 'Admin',
    pro: 'Pro',
    free: 'Free',
  },

  // === Account drawer ===
  account: {
    title: 'Account settings',
    loadFailed: 'Load failed',
    pleaseLogin: 'Please sign in first',
    getSubFailed: 'Failed to load subscription',
    getUsageFailed: 'Failed to load usage',
    getDevicesFailed: 'Failed to load devices',

    currentPlan: 'Current plan',
    adminLabel: 'Admin',
    planPro: 'Pro',
    planFree: 'Free',
    usedMonthlyQuota: 'Used / monthly quota',
    unlimitedSeconds: (sec) => `${sec.toLocaleString()} sec (∞ unlimited)`,
    usedSecondsOfLimit: (sec, max, pct) => `${sec.toLocaleString()} / ${max.toLocaleString()} sec (${pct}%)`,

    pricingTitle: 'Compare plans',
    monthlyQuota: 'Monthly quota',
    maxPerAudio: 'Max per audio',
    rateLimitPerMin: 'Rate (req/min)',
    secondsUnit: (sec) => `${sec} sec`,
    upgradeToPro: 'Upgrade to Pro',
    currentPlanBadge: 'Current plan',

    usageTitle: 'Usage details',
    totalDuration: 'Total transcription',
    totalTranscriptions: 'Transcriptions',
    successRate: 'Success rate',
    rejectedCount: 'Rejected',
    secondsValue: (sec) => `${sec.toLocaleString()} sec`,
    timesValue: (n) => `${n} times`,

    subscriptionTitle: 'Subscription',
    noSubscription: 'No active subscription',
    statusLabel: 'Status',
    statusActive: 'Active',
    statusTrialing: 'Trialing',
    statusPastDue: 'Past due',
    statusCanceled: 'Canceled',
    statusUnpaid: 'Unpaid',
    currentPeriod: 'Current period',
    periodRange: (start, end) => `${start} - ${end}`,
    willExpireOn: (date) => `Will expire on ${date}`,
    manageSubscription: 'Manage subscription',

    profileTitle: 'Profile',
    emailLabel: 'Email',
    desktopPassword: 'Desktop sign-in password',
    passwordSet: 'Set',
    passwordUnset: 'Not set',
    editEmail: 'Edit email',
    setPassword: 'Set desktop password',
    changePassword: 'Change password',
    newEmailPlaceholder: 'New email',
    newPasswordPlaceholder: 'New password (min 6 chars)',
    confirmPasswordPlaceholder: 'Re-enter new password',
    emailUpdateSent: 'Verification email sent to the new address',
    passwordSetSuccess: 'Desktop password set, you can use it on the desktop app',
    passwordTooShort: 'Password must be at least 6 characters',
    passwordMismatch: 'Passwords do not match',
    modifyFailed: 'Update failed',

    devicesTitle: 'Connected devices',
    noDevices: 'No registered devices',
    unknownDevice: 'Unknown device',
    unknown: 'Unknown',
    removeFailed: 'Remove failed',

    logout: 'Sign out',

    // Delete account
    deleteAccount: 'Delete account',
    deleteAccountConfirm: 'Are you sure you want to delete your account? All data will be permanently removed. This cannot be undone.',
    deleteAccountTypeConfirm: 'Type "DELETE" to confirm',
    deleteAccountHint: 'Account deletion is irreversible. All commands, devices, and usage records will be purged. Active subscriptions will be canceled.',
    deleteAccountProgress: 'Deleting account…',
    deleteAccountSuccess: 'Account deleted',
    deleteAccountFailed: 'Failed to delete account, please try again later',
    deleteAccountAdminProtected: 'Admin accounts cannot be deleted',

    languageTitle: 'Language',
    languageZhCN: '简体中文',
    languageEn: 'English',
  },

  // === Auth Overlay ===
  auth: {
    eyebrow: 'VOICE TO ANY TEXT FIELD',
    subtitleLogin: 'Sign in and your phone recordings appear at the desktop cursor',
    subtitleSignup: 'Create a free account to pair phone and desktop over any network',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    forgotPassword: 'Forgot password?',
    passwordPlaceholder: 'At least 6 characters',
    submitLogin: 'Sign in',
    submitSignup: 'Sign up',
    switchToSignup: "Don't have an account? Sign up",
    switchToLogin: 'Already have an account? Sign in',
    orDivider: 'or',
    githubButton: 'Continue with GitHub',
    resendVerification: 'Resend verification email',
    resetPasswordTitle: 'Reset password',
    resetPasswordCopy: 'Enter your registered email and we will send you a reset link.',
    sendResetLink: 'Send reset link',
    backToLogin: 'Back to sign in',
    backToReset: 'Recover your VoiceBridge account',
    footnote: 'Phone and desktop do not need to be on the same network',
    missingConfig: 'Missing Supabase config, please check /config.js.',
    signupSuccess: 'Sign up successful, please check your inbox to verify.',
    authRequestFailed: 'Auth request failed, please retry.',
    githubFailed: 'GitHub sign-in failed, please retry.',
    resetSent: 'Reset link sent to your inbox.',
    resetSentShort: 'Sent',
    resetSendFailed: 'Send failed, please retry.',
  },

  // === Pairing Overlay ===
  pairing: {
    defaultDeviceName: 'VoiceBridge Desktop',
    secureTitle: 'Secure pairing request',
    bindDesktop: 'Pair this desktop',
    description: 'After approval, your phone transcription is encrypted and sent to this desktop, then pasted at the current cursor.',
    confirm: 'Allow and pair',
    cancel: 'Not now',
    binding: 'Securely pairing…',
    sessionExpired: 'Session expired, please sign in again.',
    bindFailedRefresh: 'Pairing failed, please refresh the desktop QR and retry.',
    bound: (name) => `Paired with ${name}, desktop will come online.`,
    success: 'Paired successfully',
    failed: 'Pairing failed, please retry.',
  },

  // === Command Store ===
  commandStore: {
    loginRequired: 'Please sign in before using the library.',
    fetchPersonalFailed: 'Failed to load personal commands.',
    fetchPresetFailed: 'Failed to load preset commands.',
    missingFields: 'Missing text, label, or category field',
    saveFailed: 'Failed to save command.',
    missingId: 'Missing command id',
    nothingToUpdate: 'Nothing to update.',
    updateFailed: 'Failed to update command.',
    notExist: 'Command not found.',
    deleteFailed: 'Failed to delete command.',
    operationFailed: 'Command operation failed.',
  },

  // === Time formatting ===
  time: {
    justNow: 'just now',
    minutesAgo: (n) => `${n} min ago`,
    hoursAgo: (n) => `${n} h ago`,
    daysAgo: (n) => `${n} d ago`,
    monthsAgo: (n) => `${n} mo ago`,
  },

  // === Footer legal links ===
  footer: {
    privacy: 'Privacy Policy',
    terms: 'Terms of Service',
    faq: 'FAQ',
  },
};
