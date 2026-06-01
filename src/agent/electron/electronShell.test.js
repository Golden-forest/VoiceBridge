import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
const mainJs = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const preloadJs = await readFile(new URL('./preload.js', import.meta.url), 'utf8');
const rendererHtml = await readFile(new URL('./renderer.html', import.meta.url), 'utf8');

test('package exposes Electron Forge scripts without replacing the web start script', () => {
  assert.equal(packageJson.scripts.start, 'node src/server/index.js');
  assert.equal(packageJson.scripts['electron:start'], 'electron-forge start');
  assert.equal(packageJson.scripts.package, 'electron-forge package');
  assert.equal(packageJson.scripts.make, 'electron-forge make');
});

test('Electron main process uses a safe BrowserWindow shell', () => {
  assert.match(mainJs, /width:\s*420/);
  assert.match(mainJs, /height:\s*560/);
  assert.match(mainJs, /contextIsolation:\s*true/);
  assert.match(mainJs, /nodeIntegration:\s*false/);
  assert.match(mainJs, /voicebridge:version/);
  assert.match(mainJs, /window-all-closed/);
});

test('preload exposes a minimal VoiceBridge bridge API', () => {
  assert.match(preloadJs, /contextBridge\.exposeInMainWorld\('voicebridge'/);
  assert.match(preloadJs, /version:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('voicebridge:version'\)/);
});

test('renderer is a Chinese login and status shell with a content security policy', () => {
  assert.match(rendererHtml, /Content-Security-Policy/);
  assert.match(rendererHtml, /登录/);
  assert.match(rendererHtml, /连接状态/);
});
