// LAN 配对码主进程侧状态：把 lanServer 的可变状态（6 位配对码会按 TTL 轮换、
// 成功配对后一次性重置）整形成可发给渲染进程的负载，并在配对码变化时推送。
// 纯逻辑抽出为独立模块，便于用 node:test 覆盖（Electron 主进程本身不可直测）。

/**
 * 把 lanServer 实例（或 null）整形为渲染进程负载。
 * LAN 服务未运行时返回 running:false，渲染端据此隐藏局域网区块。
 */
export function buildLanState(lanServer) {
  if (!lanServer) return { running: false, pairingCode: null, endpoints: [] };
  let endpoints = [];
  try {
    endpoints = lanServer.getEndpoints() || [];
  } catch {
    endpoints = [];
  }
  let pairingCode = null;
  try {
    pairingCode = typeof lanServer.pairingCode === 'string' ? lanServer.pairingCode : null;
  } catch {
    pairingCode = null;
  }
  return { running: true, pairingCode, endpoints };
}

/**
 * 轮询 lanServer.pairingCode，仅在变化时 send（配对码轮换 / 服务停止）。
 * startLanServer 成功后用 tick(true) 立即推送一次初始状态。
 */
export function createLanCodeWatcher({ getState, send, intervalMs = 3000, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let lastSignature = null;
  const tick = (force = false) => {
    const state = getState();
    const signature = state?.running ? String(state.pairingCode) : 'off';
    if (!force && signature === lastSignature) return false;
    lastSignature = signature;
    send(state);
    return true;
  };
  const timer = setIntervalFn(() => tick(false), intervalMs);
  return {
    tick,
    stop() {
      clearIntervalFn(timer);
    }
  };
}
