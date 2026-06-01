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
  assert.equal(packageJson.config.forge.packagerConfig.prune, false);
  assert.equal(
    packageJson.config.forge.packagerConfig.download.mirrorOptions.mirror,
    'https://npmmirror.com/mirrors/electron/'
  );
  assert.ok(packageJson.config.forge.packagerConfig.ignore.includes('^/out($|/)'));
  assert.ok(packageJson.config.forge.packagerConfig.ignore.includes('^/\\.env($|\\.)'));
});

test('Electron main process uses a safe BrowserWindow shell', () => {
  assert.match(mainJs, /width:\s*420/);
  assert.match(mainJs, /height:\s*560/);
  assert.match(mainJs, /contextIsolation:\s*true/);
  assert.match(mainJs, /nodeIntegration:\s*false/);
  assert.match(mainJs, /preload\.cjs/);
  assert.match(mainJs, /voicebridge:version/);
  assert.match(mainJs, /voicebridge:login/);
  assert.match(mainJs, /startRealtimeAgent/);
  assert.match(mainJs, /\.from\('devices'\)\.upsert/);
  assert.match(mainJs, /desktop-config\.json/);
  assert.match(mainJs, /window-all-closed/);
});

test('preload exposes a minimal VoiceBridge bridge API', () => {
  assert.match(preloadJs, /require\('electron'\)/);
  assert.doesNotMatch(preloadJs, /from 'electron'/);
  assert.match(preloadJs, /contextBridge\.exposeInMainWorld\('voicebridge'/);
  assert.match(preloadJs, /version:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('voicebridge:version'\)/);
  assert.match(preloadJs, /login:\s*\(credentials\)\s*=>\s*ipcRenderer\.invoke\('voicebridge:login'/);
  assert.match(preloadJs, /onAgentStatus/);
});

test('renderer is a Chinese login and status shell with a content security policy', () => {
  assert.match(rendererHtml, /Content-Security-Policy/);
  assert.match(rendererHtml, /登录/);
  assert.match(rendererHtml, /连接状态/);
  assert.match(rendererHtml, /登录并上线/);
  assert.match(rendererHtml, /voicebridge\.login/);
});

test('Electron packaging writes a bundled public Supabase config', () => {
  assert.match(writeConfigJs, /VOICEBRIDGE_DESKTOP_SUPABASE_URL/);
  assert.match(writeConfigJs, /VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY/);
  assert.match(writeConfigJs, /desktop-config\.json/);
  assert.match(writeConfigJs, /process\.exit\(1\)/);
});
