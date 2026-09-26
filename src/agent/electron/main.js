import { app, BrowserWindow, clipboard, ipcMain, net, powerMonitor } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createFileAuthStorage } from '../authStorage.js';
import { createAgentLogger } from './agentLogger.js';
import { loadOrCreateDevice, rotateDeviceIdentity } from '../deviceStore.js';
import { createAgentClient, startRealtimeAgent } from '../realtimeAgent.js';
import { buildLanState, createLanCodeWatcher, isLanAllowedPlan } from './lanState.js';
import { loadConfig as loadServerConfig } from '../../server/config.js';
import { loadLocalAsrCredentials } from '../../server/asrCredentials.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 经自有域名（Cloudflare Worker 反代）访问 Supabase，规避大陆 SNI 阻断。
const bundledSupabaseUrl = 'https://vb-api.heyflint.top';
const bundledWebAppUrl = 'https://voicebridge.heyflint.top/app';
const bundledDesktopConfig = loadBundledDesktopConfig();

let mainWindow = null;
let desktopClient = null;
let activeAgent = null;
let pairingPollTimer = null;
let initializing = null;
let agentLogger = null;
let lanServer = null;
let lanWatcher = null;
let lanEndpointSignature = '';
let lanNetworkRefresh = null;
// 当前登录账号的套餐：'free' | 'pro' | 'admin'。LAN 服务仅会员可用。
let currentPlan = null;
let suppressAuthRecovery = false;

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
    const deviceId = activeAgent?.device?.id;
    if (!deviceId) {
      log('lan-device-missing');
      return null;
    }
    // 可选本地腾讯凭证（userData/voicebridge.env）：存在即恢复本地签名直连
    // 通道（自用最快路径）；不存在则保持 Edge 逐次签名通道（密钥不出云端）。
    const localAsrCredentials = await loadLocalAsrCredentials(userData);
    if (localAsrCredentials) {
      log('lan-local-asr-credentials-active', { region: localAsrCredentials.tencentAsrRegion || null });
    }
    lanServer = await createLanServer({
      rootDir,
      deviceId,
      ...(localAsrCredentials ? { config: { ...loadServerConfig(), ...localAsrCredentials } } : {}),
      certsDir: join(userData, 'certs'),
      tmpDir: join(userData, 'tmp'),
      // 配对 token 落盘（userData 在 asar 外可写）：网络切换重建服务 / App
      // 重启后手机不需要重新输入配对码。TTL 滑动续期，长期不用才过期。
      pairingTokensPath: join(userData, 'lan-pairing.json'),
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
    lanEndpointSignature = getLanEndpointSignature(lanServer);
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
  lanEndpointSignature = '';
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

function getLanEndpointSignature(server) {
  if (!server) return '';
  try {
    return server.getEndpoints()
      .map(({ host }) => host)
      .filter(Boolean)
      .sort()
      .join(',');
  } catch {
    return '';
  }
}

async function refreshLanServerForNetworkChange() {
  if (!lanServer || !activeAgent || lanNetworkRefresh) return lanNetworkRefresh;
  const nextSignature = getLanEndpointSignature(lanServer);
  if (!nextSignature || nextSignature === lanEndpointSignature) return null;
  lanNetworkRefresh = (async () => {
    log('lan-network-changed', { from: lanEndpointSignature, to: nextSignature });
    await stopLanServer();
    await startLanServer();
    try {
      await activeAgent?.runtime?.setLanEndpoints?.(lanServer ? lanServer.getEndpoints() : []);
    } catch (error) {
      log('lan-endpoints-refresh-failed', { error: error instanceof Error ? error.message : String(error) });
    }
  })();
  try {
    await lanNetworkRefresh;
  } finally {
    lanNetworkRefresh = null;
  }
  return null;
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
    const { data: userData, error: userError } = await desktopClient.auth.getUser();
    if (userError || !userData.user) {
      log('auth-stale-session', { error: userError?.message });
      suppressAuthRecovery = true;
      try {
        await desktopClient.auth.signOut();
      } finally {
        suppressAuthRecovery = false;
      }
    }
  }
  return desktopClient;
}

// 会话失效（刷新令牌吊销、密码修改、用户被删）时，私有通道 join 会永远
// 403，桌面端表现为"掉线直到重启"。这里监听 SIGNED_OUT，停掉所有服务并
// 自动创建新的匿名运行会话并回到扫码状态，让设备自行恢复。
function watchAuthLifecycle(supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    log('auth-event', { event, userId: session?.user?.id ?? null });
    if (event === 'SIGNED_OUT' && !suppressAuthRecovery) {
      log('auth-signed-out-recovery', { previousUserId: activeAgent?.userId ?? null });
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
  return await initializeDesktop();
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
  const device = await loadOrCreateDevice();
  const runtimeUser = await ensureAnonymousSession(supabase);
  if (!runtimeUser.is_anonymous) {
    await migrateLegacyDesktopSession(supabase, device);
  }
  const status = await fetchPairingStatus({ supabase, deviceId: device.id });
  if (status.paired) {
    return await goOnline({
      supabase,
      userId: status.user_id,
      device,
      plan: status.plan
    });
  }
  try {
    return await startPairing({ supabase, device });
  } catch (error) {
    if (error?.code !== 'device_conflict') throw error;
    // A stale anonymous runtime cannot safely reclaim an active device id.
    // Rotate only the local id and require a fresh phone scan; the old account
    // binding remains untouched and can be removed later from Connected Devices.
    const replacement = await rotateDeviceIdentity();
    log('device-identity-rotated', { previousDeviceId: device.id, deviceId: replacement.id });
    return await startPairing({ supabase, device: replacement });
  }
}

async function ensureAnonymousSession(supabase) {
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session?.user) return sessionData.session.user;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) throw new Error(error?.message || '无法创建电脑配对会话。');
  return data.user;
}

async function migrateLegacyDesktopSession(supabase, device) {
  const { error: revokeError } = await supabase.from('devices').update({
    status: 'revoked',
    updated_at: new Date().toISOString()
  }).eq('id', device.id);
  if (revokeError) throw new Error(`迁移旧版电脑登录失败：${revokeError.message}`);
  suppressAuthRecovery = true;
  try {
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) throw signOutError;
  } finally {
    suppressAuthRecovery = false;
  }
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) throw new Error(error?.message || '无法创建电脑配对会话。');
  log('auth-legacy-session-migrated', { runtimeUserId: data.user.id });
  return data.user;
}

async function fetchPairingStatus({ supabase, deviceId }) {
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
    body: JSON.stringify({ action: 'status', device_id: deviceId })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || '无法读取电脑配对状态。');
  }
  return payload;
}

async function startPairing({ supabase, device }) {
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
    const error = new Error(payload?.message || '无法生成配对二维码。');
    error.code = payload?.code || '';
    throw error;
  }

  const pairingUri = buildNativePairingUri(payload.pairing_token, device.name);
  const qrDataUrl = await QRCode.toDataURL(pairingUri, {
    width: 280,
    margin: 1,
    color: { dark: '#17202a', light: '#ffffff' }
  });
  const state = sendDesktopState({
    mode: 'pairing',
    qrDataUrl,
    pairingUrl: pairingUri,
    deviceName: device.name,
    expiresAt: payload.expires_at
  });
  schedulePairingPoll({ supabase, device });
  return state;
}

async function startAdditionalPairing() {
  if (!activeAgent?.device || !desktopClient) {
    throw new Error('电脑端尚未上线，请稍后再试。');
  }
  clearPairingPoll();
  const config = getDesktopPublicConfig();
  const { data: sessionData } = await desktopClient.auth.getSession();
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
      action: 'start_additional',
      device_id: activeAgent.device.id
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || '无法生成新的配对二维码。');
  }

  const pairingUri = buildNativePairingUri(payload.pairing_token, activeAgent.device.name);
  const qrDataUrl = await QRCode.toDataURL(pairingUri, {
    width: 280,
    margin: 1,
    color: { dark: '#17202a', light: '#ffffff' }
  });
  const state = sendDesktopState({
    mode: 'additional-pairing',
    qrDataUrl,
    pairingUrl: pairingUri,
    deviceName: activeAgent.device.name,
    expiresAt: payload.expires_at
  });
  scheduleAdditionalPairingPoll();
  return state;
}

function buildNativePairingUri(pairingToken, deviceName) {
  const pairingUri = new URL('voicebridge://pair');
  pairingUri.searchParams.set('pairing_token', pairingToken);
  pairingUri.searchParams.set('device', deviceName);
  return pairingUri.href;
}

function sendOnlineDesktopState() {
  if (!activeAgent?.device) throw new Error('电脑端尚未上线。');
  const settings = loadDesktopSettings();
  return sendDesktopState({
    mode: 'online',
    deviceName: activeAgent.device.name,
    reportWindowTitles: settings.reportWindowTitles,
    plan: currentPlan,
    lanAllowed: isLanAllowedPlan(currentPlan)
  });
}

function scheduleAdditionalPairingPoll() {
  clearPairingPoll();
  const poll = async () => {
    if (!activeAgent || !desktopClient) return;
    try {
      const status = await fetchPairingStatus({
        supabase: desktopClient,
        deviceId: activeAgent.device.id
      });
      if (!status.additional_pairing_pending) {
        clearPairingPoll();
        sendOnlineDesktopState();
        return;
      }
    } catch (error) {
      sendAgentStatus(`pairing:${error instanceof Error ? error.message : String(error)}`);
    }
    pairingPollTimer = setTimeout(poll, 1500);
  };
  pairingPollTimer = setTimeout(poll, 1000);
}

async function cancelAdditionalPairing() {
  clearPairingPoll();
  if (activeAgent?.device && desktopClient) {
    try {
      const config = getDesktopPublicConfig();
      const { data: sessionData } = await desktopClient.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (accessToken) {
        const response = await fetch(`${config.supabaseUrl}/functions/v1/device-pairing`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: config.supabaseAnonKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'cancel_additional',
            device_id: activeAgent.device.id
          })
        });
        if (!response.ok) log('additional-pairing-cancel-failed', { status: response.status });
      }
    } catch (error) {
      // The desktop must still be able to leave the QR screen while offline.
      log('additional-pairing-cancel-failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return sendOnlineDesktopState();
}

function schedulePairingPoll(context) {
  clearPairingPoll();
  const poll = async () => {
    try {
      const status = await fetchPairingStatus({
        supabase: context.supabase,
        deviceId: context.device.id
      });
      if (status.paired) {
        clearPairingPoll();
        await goOnline({
          supabase: context.supabase,
          userId: status.user_id,
          device: context.device,
          plan: status.plan
        });
        return;
      }
    } catch (error) {
      sendAgentStatus(`pairing:${error instanceof Error ? error.message : String(error)}`);
    }
    pairingPollTimer = setTimeout(poll, 1500);
  };
  pairingPollTimer = setTimeout(poll, 1000);
}

async function goOnline({ supabase, userId, device, plan = 'free' }) {
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
  currentPlan = ['admin', 'pro', 'free'].includes(plan) ? plan : 'free';
  const lanAllowed = isLanAllowedPlan(currentPlan);
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
  return sendOnlineDesktopState();
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
    suppressAuthRecovery = true;
    try {
      await desktopClient.auth.signOut();
    } finally {
      suppressAuthRecovery = false;
    }
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
ipcMain.handle('voicebridge:refresh-pairing', () => initializeDesktopInternal());
ipcMain.handle('voicebridge:show-pairing-qr', () => startAdditionalPairing());
ipcMain.handle('voicebridge:cancel-pairing-qr', () => cancelAdditionalPairing());
ipcMain.handle('voicebridge:unpair', () => unpairDesktop());
ipcMain.handle('voicebridge:copy-text', (_event, value) => {
  clipboard.writeText(String(value || ''));
  return { ok: true };
});
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
    if (online) void refreshLanServerForNetworkChange();
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
