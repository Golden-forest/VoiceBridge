import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLanState, createLanCodeWatcher } from './lanState.js';

function fakeLanServer({ code = '123456', endpoints = [{ host: '192.168.1.5', port: 47001, httpPort: 47002 }] } = {}) {
  return {
    get pairingCode() { return code; },
    getEndpoints: () => endpoints
  };
}

test('buildLanState reports a running LAN server with pairing code and endpoints', () => {
  const state = buildLanState(fakeLanServer());
  assert.equal(state.running, true);
  assert.equal(state.pairingCode, '123456');
  assert.deepEqual(state.endpoints, [{ host: '192.168.1.5', port: 47001, httpPort: 47002 }]);
});

test('buildLanState hides the LAN block when the server is not running', () => {
  assert.deepEqual(buildLanState(null), { running: false, pairingCode: null, endpoints: [] });
});

test('buildLanState degrades gracefully when endpoint access fails', () => {
  const broken = {
    get pairingCode() { throw new Error('server closed'); },
    getEndpoints() { throw new Error('no network'); }
  };
  const state = buildLanState(broken);
  assert.equal(state.running, true);
  assert.equal(state.pairingCode, null);
  assert.deepEqual(state.endpoints, []);
});

test('lan watcher pushes initial state, propagates rotation, and stays quiet without change', () => {
  let currentCode = '111111';
  const sent = [];
  const timers = [];
  const watcher = createLanCodeWatcher({
    getState: () => buildLanState(currentCode ? fakeLanServer({ code: currentCode }) : null),
    send: (state) => sent.push(state),
    intervalMs: 10,
    setIntervalFn: (fn) => { timers.push(fn); return timers.length; },
    clearIntervalFn: () => {}
  });

  // 初始状态：强制推送一次。
  watcher.tick(true);
  assert.deepEqual(sent.map((s) => s.pairingCode), ['111111']);

  // 无变化：不重复推送。
  timers[0]();
  assert.equal(sent.length, 1);

  // 配对码轮换（TTL 过期或成功配对）：推送新码。
  currentCode = '222222';
  timers[0]();
  assert.deepEqual(sent.map((s) => s.pairingCode), ['111111', '222222']);

  // 服务停止：推送 running:false。
  currentCode = null;
  timers[0]();
  assert.equal(sent.at(-1).running, false);
  assert.equal(sent.at(-1).pairingCode, null);
});

test('lan watcher stop clears the poll timer', () => {
  let cleared = 0;
  const watcher = createLanCodeWatcher({
    getState: () => buildLanState(null),
    send: () => {},
    intervalMs: 10,
    setIntervalFn: () => 1,
    clearIntervalFn: () => { cleared += 1; }
  });
  watcher.stop();
  assert.equal(cleared, 1);
});
