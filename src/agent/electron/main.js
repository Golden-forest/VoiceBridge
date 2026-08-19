import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createFileAuthStorage } from '../authStorage.js';
import { createAgentLogger } from './agentLogger.js';
import { loadOrCreateDevice } from '../deviceStore.js';
import { createAgentClient, startRealtimeAgent } from '../realtimeAgent.js';

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
      }
    });
    log('lan-started', { port: lanServer.port, httpPort: lanServer.httpPort, endpoints: lanServer.getEndpoints() });
    console.log(`VoiceBridge LAN pairing code: ${lanServer.pairingCode}`);
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
    // 会话可能已失效（匿名刷新令牌吊销后不可恢复）。提前探测并清掉坏会话，
    // 否则 getUser 抛错会把应用锁死在"初始化失败"，用户无法自救。
    const { data: userData, error: userError } = await desktopClient.auth.getUser();
    if (userError || !userData.user) {
      log('auth-stale-session', { error: userError?.message });
      await desktopClient.auth.signOut();
    }
  }
  const { data: refreshed } = await desktopClient.auth.getSession();
  if (!refreshed.session) {
    const { error } = await desktopClient.auth.signInAnonymously();
    if (error) {
      throw new Error(`无法创建电脑配对会话：${error.message}`);
    }
  }
  return desktopClient;
}

// 匿名会话的刷新令牌一旦死亡（断网跨过期、吊销、用户被删），私有通道 join 会
// 永远 403，桌面端表现为"掉线直到重启"。这里监听 SIGNED_OUT，自动重新匿名
// 登录并走重配对流程，让链路自愈。
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
  const config = getDesktopPublicConfig();
  if (!desktopClient) return;
  const { error } = await desktopClient.auth.signInAnonymously();
  if (error) throw new Error(`无法重建电脑配对会话：${error.message}`);
  // 设备记录绑定的是旧 runtime 用户，重新匿名登录后必须走配对。
  const device = await loadOrCreateDevice();
  const { data: userData } = await desktopClient.auth.getUser();
  const runtimeUserId = userData.user?.id;
  if (!runtimeUserId) throw new Error('重建配对会话失败。');
  await startPairing({ supabase: desktopClient, runtimeUserId, device });
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
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error(userError?.message || '电脑配对会话无效。');
  const runtimeUserId = userData.user.id;
  const device = await loadOrCreateDevice();
  const { data: record, error: recordError } = await supabase
    .from('devices')
    .select('id,user_id,runtime_user_id,name,platform,status,paired_at')
    .eq('id', device.id)
    .maybeSingle();
  if (recordError) throw new Error(`读取设备状态失败：${recordError.message}`);

  if (
    record
    && record.status === 'active'
    && record.runtime_user_id === runtimeUserId
    && record.user_id !== runtimeUserId
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
        && data.runtime_user_id === context.runtimeUserId
        && data.user_id !== context.runtimeUserId
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
  if (settings.lanMode && !lanServer) {
    await startLanServer();
  }
  // LAN 端点上报失败绝不能拖垮云模式上线。
  try {
    await runtime.setLanEndpoints?.(lanServer ? lanServer.getEndpoints() : []);
  } catch (error) {
    log('lan-endpoints-track-failed', { error: error instanceof Error ? error.message : String(error) });
  }
  activeAgent = { supabase, runtime, device, userId };
  return sendDesktopState({
    mode: 'online',
    deviceName: device.name,
    reportWindowTitles: settings.reportWindowTitles
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
ipcMain.handle('voicebridge:initialize', () => initializeDesktop());
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
  void startLanServer();
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
}

app.on('window-all-closed', () => {
  clearPairingPoll();
  void stopRealtimeOnly();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  void stopLanServer();
});
