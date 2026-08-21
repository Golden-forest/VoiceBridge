import { app, BrowserWindow, ipcMain, net, powerMonitor } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createFileAuthStorage } from '../authStorage.js';
import { createAgentLogger } from './agentLogger.js';
import { loadOrCreateDevice } from '../deviceStore.js';
import { createAgentClient, startRealtimeAgent } from '../realtimeAgent.js';
import { buildLanState, createLanCodeWatcher } from './lanState.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundledSupabaseUrl = 'https://gqxxknusznbunkiznnal.supabase.co';
const bundledWebAppUrl = 'https://voicebridge-6kr.pages.dev';
const bundledDesktopConfig = loadBundledDesktopConfig();

let mainWindow = null;
let desktopClient = null;
let activeAgent = null;
let pairingPollTimer = null;
let initializing = null;
let agentLogger = null;
let lanServer = null;
let lanWatcher = null;
// 当前登录账号的套餐：'free' | 'pro' | 'admin'。LAN 服务仅会员可用。
let currentPlan = null;

function log(event, detail) {
  agentLogger?.log(event, detail);
}

function loadDesktopSettings() {
  try {
    const parsed = JSON.parse(readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'));
    return {
      reportWindowTitles: Boolean(parsed.reportWindowTitles),
      lanMode: parsed.lanMode !== false
    };
  } catch {
    return { reportWindowTitles: false, lanMode: true };
  }
}

function saveDesktopSettings(settings) {
  writeFileSync(
    join(app.getPath('userData'), 'settings.json'),
    JSON.stringify({
      reportWindowTitles: Boolean(settings.reportWindowTitles),
      lanMode: settings.lanMode !== false
    }, null, 2),
    'utf8'
  );
}

// 云模式下内嵌 LAN 服务：启动失败只记录日志并静默降级，绝不影响云链路。
// createLanServer 通过动态 import 加载：即使打包时 LAN 模块缺失（或加载失败），
// 也只降级为 LAN 不可用，不会让主进程崩溃。
async function startLanServer() {
  if (lanServer) return lanServer;
  const settings = loadDesktopSettings();
  if (!settings.lanMode) return null;
  try {
    let createLanServer;
    try {
      ({ createLanServer } = await import('../../server/createLanServer.js'));
    } catch (error) {
      log('lan-module-unavailable', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    // 静态资源（src/public 等）从 asar 内的应用根目录读取；
    // 证书和上传临时目录必须写到可写的 userData（asar 只读）。
    const rootDir = app.isPackaged ? app.getAppPath() : join(__dirname, '..', '..', '..');
    const userData = app.getPath('userData');
    // Edge 逐次签名直连识别（Task 5）：LAN 上传识别通过桌面端匿名会话向
    // Edge 申请一次性腾讯云签名，密钥永不出云端，也不打包进桌面安装包。
    const desktopConfig = getDesktopPublicConfig();
    lanServer = await createLanServer({
      rootDir,
      certsDir: join(userData, 'certs'),
      tmpDir: join(userData, 'tmp'),
      supabaseUrl: desktopConfig.supabaseUrl,
      supabaseAnonKey: desktopConfig.supabaseAnonKey,
      getAccessToken: async () => {
        try {
          const supabase = desktopClient || await getOrCreateDesktopClient();
          const { data } = await supabase.auth.getSession();
          return data?.session?.access_token || null;
        } catch {
          return null;
        }
      },
      onPairingKnock: revealLanCode
    });
    log('lan-started', { port: lanServer.port, httpPort: lanServer.httpPort, endpoints: lanServer.getEndpoints() });
    console.log(`VoiceBridge LAN pairing code: ${lanServer.pairingCode}`);
    startLanWatcher();
    sendLanState();
    return lanServer;
  } catch (error) {
    lanServer = null;
    log('lan-start-failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function stopLanServer() {
  if (!lanServer) return;
  const server = lanServer;
  lanServer = null;
  clearTimeout(lanCodeHideTimer);
  lanCodeHideTimer = null;
  lanCodeVisible = false;
  lanWatcher?.stop();
  lanWatcher = null;
  sendLanState();
  try {
    await server.close();
    log('lan-stopped');
  } catch (error) {
    log('lan-stop-failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

function getDesktopPublicConfig() {
  return {
    supabaseUrl: process.env.VOICEBRIDGE_DESKTOP_SUPABASE_URL
      || process.env.SUPABASE_URL
      || bundledDesktopConfig.supabaseUrl
      || bundledSupabaseUrl,
    supabaseAnonKey: process.env.VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY
      || process.env.SUPABASE_ANON_KEY
      || bundledDesktopConfig.supabaseAnonKey
      || '',
    webAppUrl: process.env.VOICEBRIDGE_WEB_APP_URL
      || bundledDesktopConfig.webAppUrl
      || bundledWebAppUrl
  };
}

function loadBundledDesktopConfig() {
  try {
    const raw = readFileSync(join(__dirname, 'desktop-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      supabaseUrl: typeof parsed.supabaseUrl === 'string' ? parsed.supabaseUrl : '',
      supabaseAnonKey: typeof parsed.supabaseAnonKey === 'string' ? parsed.supabaseAnonKey : '',
      webAppUrl: typeof parsed.webAppUrl === 'string' ? parsed.webAppUrl : ''
    };
  } catch {
    return { supabaseUrl: '', supabaseAnonKey: '', webAppUrl: '' };
  }
}

function sendAgentStatus(status) {
  log('agent-status', status);
  mainWindow?.webContents.send('voicebridge:agent-status', status);
}

function sendDesktopState(state) {
  mainWindow?.webContents.send('voicebridge:desktop-state', state);
  return state;
}

// LAN 配对码按需显示：手机在 LAN 页面敲门（探测配对状态）后亮码 3 分钟，
// 之后自动隐藏。平时桌面端只显示引导语，配对码不出现在屏幕上。
const LAN_CODE_VISIBLE_MS = 3 * 60 * 1000;
let lanCodeVisible = false;
let lanCodeHideTimer = null;

function sendLanState() {
  mainWindow?.webContents.send('voicebridge:lan-state', buildLanState(lanServer, lanCodeVisible));
}

function revealLanCode() {
  lanCodeVisible = true;
  clearTimeout(lanCodeHideTimer);
  lanCodeHideTimer = setTimeout(() => {
    lanCodeVisible = false;
    sendLanState();
  }, LAN_CODE_VISIBLE_MS);
  log('lan-pairing-knock');
  sendLanState();
}

function startLanWatcher() {
  if (lanWatcher) return;
  lanWatcher = createLanCodeWatcher({
    getState: () => buildLanState(lanServer, lanCodeVisible),
    send: sendLanState,
    intervalMs: 3000
  });
}

async function getOrCreateDesktopClient() {
  if (desktopClient) return desktopClient;
  const config = getDesktopPublicConfig();
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('桌面端缺少 Supabase 公开配置。');
  }
  desktopClient = createAgentClient({
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    storage: createFileAuthStorage()
  });
  watchAuthLifecycle(desktopClient);
  const { data: sessionData } = await desktopClient.auth.getSession();
  if (sessionData.session) {
    // 会话可能已失效（刷新令牌吊销后不可恢复）。提前探测并清掉坏会话，
    // 否则 getUser 抛错会把应用锁死在"初始化失败"，用户无法自救。
    // 存量安装里的旧匿名会话也一并清除：桌面端现在要求真实账号登录。
    const { data: userData, error: userError } = await desktopClient.auth.getUser();
    if (userError || !userData.user) {
      log('auth-stale-session', { error: userError?.message });
      await desktopClient.auth.signOut();
    } else if (userData.user.is_anonymous) {
      log('auth-legacy-anonymous-session');
      await desktopClient.auth.signOut();
    }
  }
  return desktopClient;
}

// 桌面账号套餐判定：管理员 > 有效订阅 > 免费。与云端 reserve_and_get_plan
// RPC 的语义保持一致（subscriptions active/trialing 记为 pro）。
async function resolveDesktopPlan(supabase, userId) {
  const [subscriptions, profiles] = await Promise.all([
    supabase.from('subscriptions').select('status').eq('user_id', userId).maybeSingle(),
    supabase.from('profiles').select('is_admin').eq('user_id', userId).maybeSingle()
  ]);
  if (profiles.error) throw new Error(`读取账号信息失败：${profiles.error.message}`);
  if (profiles.data?.is_admin) return 'admin';
  const status = subscriptions.data?.status;
  if (status === 'active' || status === 'trialing') return 'pro';
  return 'free';
}

// 会话失效（刷新令牌吊销、密码修改、用户被删）时，私有通道 join 会永远
// 403，桌面端表现为"掉线直到重启"。这里监听 SIGNED_OUT，停掉所有服务并
// 回到登录面板，让用户重新登录自愈。
function watchAuthLifecycle(supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    log('auth-event', { event, userId: session?.user?.id ?? null });
    if (event === 'SIGNED_OUT' && activeAgent) {
      log('auth-signed-out-recovery', { previousUserId: activeAgent.userId });
      void recoverAfterSignOut().catch((error) => {
        log('auth-recovery-failed', { error: String(error) });
      });
    }
  });
}

async function recoverAfterSignOut() {
  clearPairingPoll();
  await stopRealtimeOnly();
  await stopLanServer();
  currentPlan = null;
  sendDesktopState({ mode: 'login' });
}

async function initializeDesktop() {
  if (initializing) return initializing;
  initializing = initializeDesktopInternal().finally(() => {
    initializing = null;
  });
  return initializing;
}

async function initializeDesktopInternal() {
  clearPairingPoll();
  const supabase = await getOrCreateDesktopClient();
  // supabase-js 在无会话时 getUser() 会抛 "Auth session missing!"——
  // 这是"未登录"而不是错误，先查本地会话再决定走登录面板。
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) {
    return sendDesktopState({ mode: 'login' });
  }
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError?.message || '登录状态无效。');
  // 未登录（或旧匿名会话已被清除）→ 显示邮箱+密码登录面板。
  if (!userData.user) {
    return sendDesktopState({ mode: 'login' });
  }
  if (userData.user.is_anonymous) {
    await supabase.auth.signOut();
    return sendDesktopState({ mode: 'login' });
  }
  const runtimeUserId = userData.user.id;
  const device = await loadOrCreateDevice();
  const { data: record, error: recordError } = await supabase
    .from('devices')
    .select('id,user_id,runtime_user_id,name,platform,status,paired_at')
    .eq('id', device.id)
    .maybeSingle();
  if (recordError) throw new Error(`读取设备状态失败：${recordError.message}`);

  // 设备已激活且归属明确：同账号自激活（user_id === runtime）与手机扫码
  // claim（user_id !== runtime）两条路径都直接上线。
  if (
    record
    && record.status === 'active'
    && record.user_id
    && record.paired_at
  ) {
    return await goOnline({ supabase, userId: record.user_id, device });
  }

  return await startPairing({ supabase, runtimeUserId, device });
}

async function startPairing({ supabase, runtimeUserId, device }) {
  await stopRealtimeOnly();
  const config = getDesktopPublicConfig();
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error('电脑配对会话已失效。');
  const response = await fetch(`${config.supabaseUrl}/functions/v1/device-pairing`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: config.supabaseAnonKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'start',
      device: {
        id: device.id,
        name: device.name,
        platform: device.platform,
        app_version: app.getVersion()
      }
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || '无法生成配对二维码。');
  }

  const pairingUrl = new URL(config.webAppUrl);
  pairingUrl.searchParams.set('pairing_token', payload.pairing_token);
  pairingUrl.searchParams.set('device', device.name);
  const qrDataUrl = await QRCode.toDataURL(pairingUrl.href, {
    width: 280,
    margin: 1,
    color: { dark: '#17202a', light: '#ffffff' }
  });
  const state = sendDesktopState({
    mode: 'pairing',
    qrDataUrl,
    pairingUrl: pairingUrl.href,
    deviceName: device.name,
    expiresAt: payload.expires_at
  });
  schedulePairingPoll({ supabase, runtimeUserId, device });
  return state;
}

function schedulePairingPoll(context) {
  clearPairingPoll();
  const poll = async () => {
    try {
      const { data, error } = await context.supabase
        .from('devices')
        .select('user_id,runtime_user_id,status,paired_at')
        .eq('id', context.device.id)
        .maybeSingle();
      if (error) throw error;
      if (
        data
        && data.status === 'active'
        && data.user_id
        && data.paired_at
      ) {
        clearPairingPoll();
        await goOnline({ supabase: context.supabase, userId: data.user_id, device: context.device });
        return;
      }
    } catch (error) {
      sendAgentStatus(`pairing:${error instanceof Error ? error.message : String(error)}`);
    }
    pairingPollTimer = setTimeout(poll, 1500);
  };
  pairingPollTimer = setTimeout(poll, 1000);
}

async function goOnline({ supabase, userId, device }) {
  await stopRealtimeOnly();
  const settings = loadDesktopSettings();
  const runtime = await startRealtimeAgent({
    supabase,
    userId,
    device,
    appVersion: app.getVersion(),
    reportWindowTitles: settings.reportWindowTitles,
    onStatus: sendAgentStatus
  });
  // 先登记 activeAgent 再做后续步骤：若之后任何一步抛错，stopRealtimeOnly
  // 才能停掉已启动的 runtime，否则通道和定时器会泄漏到进程结束。
  activeAgent = { supabase, runtime, device, userId };
  // LAN 功能会员专属：登录账号 plan ∈ {pro, admin} 才启动内嵌 LAN 服务。
  // 套餐查询失败（网络瞬断）不能让整个上线失败——那会把用户锁死在
  // "初始化失败"且没有重试入口。降级为 LAN 不可用，云链路照常工作。
  let lanAllowed = false;
  try {
    currentPlan = await resolveDesktopPlan(supabase, userId);
    lanAllowed = currentPlan === 'pro' || currentPlan === 'admin';
  } catch (error) {
    currentPlan = null;
    log('plan-resolve-failed', { error: error instanceof Error ? error.message : String(error) });
  }
  if (lanAllowed) {
    if (settings.lanMode && !lanServer) {
      await startLanServer();
    }
  } else {
    await stopLanServer();
  }
  // LAN 端点上报失败绝不能拖垮云模式上线。
  try {
    await runtime.setLanEndpoints?.(lanServer ? lanServer.getEndpoints() : []);
  } catch (error) {
    log('lan-endpoints-track-failed', { error: error instanceof Error ? error.message : String(error) });
  }
  return sendDesktopState({
    mode: 'online',
    deviceName: device.name,
    reportWindowTitles: settings.reportWindowTitles,
    plan: currentPlan,
    lanAllowed
  });
}

function clearPairingPoll() {
  clearTimeout(pairingPollTimer);
  pairingPollTimer = null;
}

async function stopRealtimeOnly() {
  if (!activeAgent) return;
  const agent = activeAgent;
  activeAgent = null;
  await agent.runtime?.stop();
}

async function unpairDesktop() {
  clearPairingPoll();
  await stopRealtimeOnly();
  if (desktopClient) {
    const device = await loadOrCreateDevice();
    await desktopClient.from('devices').update({
      status: 'revoked',
      updated_at: new Date().toISOString()
    }).eq('id', device.id);
    await desktopClient.auth.signOut();
    desktopClient = null;
  }
  return await initializeDesktop();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 620,
    minWidth: 360,
    minHeight: 540,
    title: 'VoiceBridge Agent',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs')
    }
  });
  mainWindow.loadFile(join(__dirname, 'renderer.html'));
}

ipcMain.handle('voicebridge:version', () => app.getVersion());
ipcMain.handle('voicebridge:public-config', () => {
  const config = getDesktopPublicConfig();
  return {
    supabaseUrl: config.supabaseUrl,
    webAppUrl: config.webAppUrl,
    hasSupabaseAnonKey: Boolean(config.supabaseAnonKey)
  };
});
ipcMain.handle('voicebridge:lan-state', () => buildLanState(lanServer, lanCodeVisible));
ipcMain.handle('voicebridge:initialize', () => initializeDesktop());
ipcMain.handle('voicebridge:login', async (_event, credentials) => {
  const email = String(credentials?.email || '').trim();
  const password = String(credentials?.password || '');
  if (!email || !password) throw new Error('请输入邮箱和密码。');
  const supabase = await getOrCreateDesktopClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  log('auth-login', { email });
  return await initializeDesktopInternal();
});
// 邮箱验证码登录（OTP）：GitHub / 谷歌 OAuth 注册的账号没有密码，走邮件
// 验证码。shouldCreateUser:false 保证只允许已注册邮箱，不产生新账号。
ipcMain.handle('voicebridge:otp-send', async (_event, email) => {
  const normalized = String(email || '').trim();
  if (!normalized) throw new Error('请输入邮箱。');
  const supabase = await getOrCreateDesktopClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: normalized,
    options: { shouldCreateUser: false }
  });
  if (error) throw new Error(error.message);
  log('auth-otp-send', { email: normalized });
  return { ok: true };
});
ipcMain.handle('voicebridge:login-otp', async (_event, credentials) => {
  const email = String(credentials?.email || '').trim();
  const token = String(credentials?.token || '').trim();
  if (!email || !token) throw new Error('请输入邮箱和验证码。');
  const supabase = await getOrCreateDesktopClient();
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw new Error(error.message);
  log('auth-login-otp', { email });
  return await initializeDesktopInternal();
});
ipcMain.handle('voicebridge:refresh-pairing', () => initializeDesktopInternal());
ipcMain.handle('voicebridge:unpair', () => unpairDesktop());
ipcMain.handle('voicebridge:update-settings', async (_event, updates) => {
  const settings = {
    ...loadDesktopSettings(),
    reportWindowTitles: Boolean(updates?.reportWindowTitles)
  };
  saveDesktopSettings(settings);
  await activeAgent?.runtime?.setReportWindowTitles(settings.reportWindowTitles);
  return settings;
});

app.whenReady().then(() => {
  agentLogger = createAgentLogger({ userDataPath: app.getPath('userData') });
  log('app-start', { version: app.getVersion(), platform: process.platform });
  createWindow();
  wireLifecycleEvents();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS 睡眠唤醒后，realtime socket 要等 25–50s 心跳超时才发现链路已死。
// 监听电源/网络事件，唤醒和恢复联网时立即主动重连，把盲区压到秒级。
function wireLifecycleEvents() {
  powerMonitor.on('resume', () => {
    log('power-resume');
    activeAgent?.runtime?.forceReconnect?.('power-resume');
  });
  powerMonitor.on('lock-screen', () => log('power-lock'));
  // Wi-Fi 切换 / 断网重连没有专门的系统事件可订阅；realtime 要等约 30s
  // 心跳超时才能发现链路已死。轮询 net.isOnline()，在"断→通"瞬间主动
  // 重连，把假在线盲区压到轮询间隔（5s）以内。
  let wasOnline = net.isOnline();
  const networkTimer = setInterval(() => {
    const online = net.isOnline();
    if (online && !wasOnline) {
      log('network-online');
      activeAgent?.runtime?.forceReconnect?.('network-online');
    }
    wasOnline = online;
  }, 5000);
  networkTimer.unref?.();
}

app.on('window-all-closed', () => {
  clearPairingPoll();
  void stopRealtimeOnly();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  void stopLanServer();
});
