import { app, BrowserWindow, ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateDevice } from '../deviceStore.js';
import { createAgentClient, startRealtimeAgent } from '../realtimeAgent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundledSupabaseUrl = 'https://gqxxknusznbunkiznnal.supabase.co';
const bundledDesktopConfig = loadBundledDesktopConfig();

let mainWindow = null;
let activeAgent = null;

function getDesktopPublicConfig() {
  return {
    supabaseUrl: process.env.VOICEBRIDGE_DESKTOP_SUPABASE_URL
      || process.env.SUPABASE_URL
      || bundledDesktopConfig.supabaseUrl
      || bundledSupabaseUrl,
    supabaseAnonKey: process.env.VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY
      || process.env.SUPABASE_ANON_KEY
      || bundledDesktopConfig.supabaseAnonKey
      || ''
  };
}

function loadBundledDesktopConfig() {
  try {
    const raw = readFileSync(join(__dirname, 'desktop-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      supabaseUrl: typeof parsed.supabaseUrl === 'string' ? parsed.supabaseUrl : '',
      supabaseAnonKey: typeof parsed.supabaseAnonKey === 'string' ? parsed.supabaseAnonKey : ''
    };
  } catch {
    return { supabaseUrl: '', supabaseAnonKey: '' };
  }
}

function sendAgentStatus(status) {
  mainWindow?.webContents.send('voicebridge:agent-status', status);
}

async function stopDesktopAgent({ signOut = false } = {}) {
  if (!activeAgent) return;
  const agent = activeAgent;
  activeAgent = null;
  await agent.runtime?.stop();
  if (signOut) {
    await agent.supabase?.auth.signOut();
  }
}

async function startDesktopAgent({ email, password }) {
  const config = getDesktopPublicConfig();
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('缺少桌面端 Supabase 公开配置。请配置 VOICEBRIDGE_DESKTOP_SUPABASE_URL 和 VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY 后再打包。');
  }
  if (!email || !password) {
    throw new Error('请输入邮箱和密码。');
  }

  await stopDesktopAgent();
  const supabase = createAgentClient({
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    throw new Error(error?.message || '登录失败。');
  }

  const device = await loadOrCreateDevice();
  const { error: upsertError } = await supabase.from('devices').upsert({
    id: device.id,
    user_id: data.user.id,
    name: device.name,
    device_type: 'desktop',
    platform: device.platform,
    status: 'active',
    last_seen_at: new Date().toISOString()
  });
  if (upsertError) {
    throw new Error(`注册桌面设备失败：${upsertError.message}`);
  }

  const runtime = await startRealtimeAgent({
    supabase,
    userId: data.user.id,
    device,
    onStatus: sendAgentStatus
  });
  activeAgent = { supabase, runtime, device };
  return { deviceId: device.id, deviceName: device.name };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 560,
    minWidth: 360,
    minHeight: 480,
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
    hasSupabaseAnonKey: Boolean(config.supabaseAnonKey)
  };
});
ipcMain.handle('voicebridge:login', async (_event, credentials) => startDesktopAgent(credentials || {}));
ipcMain.handle('voicebridge:logout', async () => {
  await stopDesktopAgent({ signOut: true });
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  void stopDesktopAgent();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
