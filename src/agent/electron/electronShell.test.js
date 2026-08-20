import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
const mainJs = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const preloadJs = await readFile(new URL('./preload.cjs', import.meta.url), 'utf8');
const rendererHtml = await readFile(new URL('./renderer.html', import.meta.url), 'utf8');
const writeConfigJs = await readFile(new URL('../../../scripts/write-electron-config.js', import.meta.url), 'utf8');

test('package exposes Electron Forge scripts without replacing the web start script', () => {
  assert.equal(packageJson.scripts.start, 'node src/server/index.js');
  assert.equal(packageJson.scripts['electron:write-config'], 'node scripts/write-electron-config.js');
  assert.equal(packageJson.scripts['electron:start'], 'electron-forge start');
  assert.equal(packageJson.scripts.package, 'electron-forge package');
  assert.equal(packageJson.scripts.make, 'electron-forge make');
  assert.equal(packageJson.scripts.prepackage, 'npm run electron:write-config');
  assert.equal(packageJson.scripts.premake, 'npm run electron:write-config');
  assert.equal(packageJson.config.electron_mirror, 'https://npmmirror.com/mirrors/electron/');
  assert.equal(packageJson.config.forge.packagerConfig.prune, true);
  assert.equal(packageJson.config.forge.packagerConfig.icon, 'assets/icon');
  assert.equal(
    packageJson.config.forge.packagerConfig.download.mirrorOptions.mirror,
    'https://npmmirror.com/mirrors/electron/'
  );
  assert.ok(packageJson.config.forge.packagerConfig.ignore.includes('^/out($|/)'));
  assert.ok(packageJson.config.forge.packagerConfig.ignore.includes('^/hosted-pwa($|/)'));
  assert.ok(packageJson.config.forge.packagerConfig.ignore.includes('^/\\.env($|\\.)'));
  // src/server 与 src/public 必须随包发布：main.js 动态 import LAN 服务，
  // LAN 静态资源也来自 src/public（详见 src/server/forge-packaging.test.js）。
  assert.ok(!packageJson.config.forge.packagerConfig.ignore.includes('^/src/public($|/)'));
  assert.ok(!packageJson.config.forge.packagerConfig.ignore.includes('^/src/server($|/)'));
});

test('Electron main process uses a safe BrowserWindow shell', () => {
  assert.match(mainJs, /width:\s*420/);
  assert.match(mainJs, /height:\s*620/);
  assert.match(mainJs, /contextIsolation:\s*true/);
  assert.match(mainJs, /nodeIntegration:\s*false/);
  assert.match(mainJs, /preload\.cjs/);
  assert.match(mainJs, /voicebridge:version/);
  assert.match(mainJs, /voicebridge:initialize/);
  assert.match(mainJs, /voicebridge:login/);
  assert.match(mainJs, /signInWithPassword/);
  assert.doesNotMatch(mainJs, /signInAnonymously/);
  assert.match(mainJs, /device-pairing/);
  assert.match(mainJs, /QRCode\.toDataURL/);
  assert.match(mainJs, /startRealtimeAgent/);
  assert.match(mainJs, /\.from\('devices'\)/);
  assert.match(mainJs, /desktop-config\.json/);
  assert.match(mainJs, /window-all-closed/);
});

test('Electron main process surfaces LAN pairing state to the renderer', () => {
  assert.match(mainJs, /buildLanState/);
  assert.match(mainJs, /createLanCodeWatcher/);
  assert.match(mainJs, /'voicebridge:lan-state'/);
  assert.match(mainJs, /lanWatcher\?\.stop\(\)/);
  assert.match(mainJs, /onPairingKnock/);
});

test('preload exposes a minimal VoiceBridge bridge API', () => {
  assert.match(preloadJs, /require\('electron'\)/);
  assert.doesNotMatch(preloadJs, /from 'electron'/);
  assert.match(preloadJs, /contextBridge\.exposeInMainWorld\('voicebridge'/);
  assert.match(preloadJs, /version:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('voicebridge:version'\)/);
  assert.match(preloadJs, /initialize:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('voicebridge:initialize'\)/);
  assert.match(preloadJs, /refreshPairing/);
  assert.match(preloadJs, /unpair/);
  assert.match(preloadJs, /login:\s*\(?credentials\)?\s*=>/);
  assert.match(preloadJs, /onAgentStatus/);
  assert.match(preloadJs, /lanState:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('voicebridge:lan-state'\)/);
  assert.match(preloadJs, /onLanState/);
});

test('renderer is a Chinese QR pairing and status shell with a content security policy', () => {
  assert.match(rendererHtml, /Content-Security-Policy/);
  assert.match(rendererHtml, /登录账号/);
  assert.match(rendererHtml, /手机扫码绑定/);
  assert.match(rendererHtml, /局域网功能需要会员/);
  assert.match(rendererHtml, /连接状态/);
  assert.match(rendererHtml, /刷新二维码/);
  assert.match(rendererHtml, /voicebridge\?\.initialize/);
  assert.match(rendererHtml, /局域网输入/);
  assert.match(rendererHtml, /id="lanPairingCode"/);
  assert.match(rendererHtml, /id="lanIdleHint"/);
  assert.match(rendererHtml, /id="lanActiveHint"/);
  assert.match(rendererHtml, /lanSection\.hidden\s*=\s*!state\?\.running/);
  assert.match(rendererHtml, /lanPairingCode\.hidden\s*=\s*!state\?\.codeVisible/);
  assert.match(rendererHtml, /onLanState\(renderLanState\)/);
});

test('Electron packaging writes a bundled public Supabase config', () => {
  assert.match(writeConfigJs, /VOICEBRIDGE_DESKTOP_SUPABASE_URL/);
  assert.match(writeConfigJs, /VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY/);
  assert.match(writeConfigJs, /desktop-config\.json/);
  assert.match(writeConfigJs, /VOICEBRIDGE_WEB_APP_URL/);
  assert.match(writeConfigJs, /voicebridge-6kr\.pages\.dev/);
  assert.match(writeConfigJs, /process\.exit\(1\)/);
});
