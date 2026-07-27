import { app, BrowserWindow, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createFileAuthStorage } from '../authStorage.js';
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

function loadDesktopSettings() {
  try {
    const parsed = JSON.parse(readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'));
    return { reportWindowTitles: Boolean(parsed.reportWindowTitles) };
  } catch {
    return { reportWindowTitles: false };
  }
}

function saveDesktopSettings(settings) {
  writeFileSync(
    join(app.getPath('userData'), 'settings.json'),
    JSON.stringify({ reportWindowTitles: Boolean(settings.reportWindowTitles) }, null, 2),
    'utf8'
  );
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
  const { data: sessionData } = await desktopClient.auth.getSession();
  if (!sessionData.session) {
    const { error } = await desktopClient.auth.signInAnonymously();
    if (error) {
      throw new Error(`无法创建电脑配对会话：${error.message}`);
    }
  }
  return desktopClient;
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  clearPairingPoll();
  void stopRealtimeOnly();
  if (process.platform !== 'darwin') app.quit();
});
