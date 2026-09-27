import { createClient } from "@supabase/supabase-js";
import {
  PROTOCOL_VERSION,
  deviceChannel,
  presenceChannel,
  isInsertTextMessage,
  isKeyMessage
} from "../shared/protocol.js";
import { outputText } from "../server/input/outputText.js";
import { activateCloudWindow, listCloudWindows } from "../server/input/windowManager.js";
import {
  pasteClipboard,
  pressEnter,
  pressEscape,
  pressUndo,
  pressDelete,
  pressCtrlC,
  pressArrow
} from "../server/input/paste.js";

const DEFAULT_KEY_HANDLERS = Object.freeze({
  paste: pasteClipboard,
  enter: pressEnter,
  escape: pressEscape,
  undo: pressUndo,
  delete: pressDelete,
  "ctrl-c": pressCtrlC,
  "arrow-up": () => pressArrow("up"),
  "arrow-down": () => pressArrow("down"),
  "arrow-left": () => pressArrow("left"),
  "arrow-right": () => pressArrow("right")
});

export async function handleDesktopMessage({
  payload,
  myDeviceId,
  output = outputText,
  keyHandlers = DEFAULT_KEY_HANDLERS,
  activateWindow = activateCloudWindow
}) {
  const activateTargetWindow = async () => {
    if (!payload.target_window_id) return;
    const result = await activateWindow(payload.target_window_id);
    if (result?.success === false) {
      throw new Error(result.error || "无法激活目标窗口");
    }
  };

  if (isKeyMessage(payload, myDeviceId)) {
    const { key, request_id, source_device_id } = payload;
    try {
      await activateTargetWindow();
      await keyHandlers[key]();
      return {
        handled: true,
        ack: {
          type: "ack",
          request_id,
          source_device_id: myDeviceId,
          target_device_id: source_device_id,
          status: "success",
          key,
          detail: `key:${key}`
        }
      };
    } catch (error) {
      return {
        handled: true,
        ack: {
          type: "ack",
          request_id,
          source_device_id: myDeviceId,
          target_device_id: source_device_id,
          status: "failed",
          key,
          detail: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  if (!isInsertTextMessage(payload, myDeviceId)) {
    return { handled: false };
  }

  try {
    await activateTargetWindow();
    const outputResult = await output(payload.text, {
      autoPaste: Boolean(payload.auto_paste)
    });
    const pasteFailed = Boolean(payload.auto_paste && outputResult.pasteError);
    return {
      handled: true,
      ack: {
        type: "ack",
        request_id: payload.request_id,
        source_device_id: myDeviceId,
        target_device_id: payload.source_device_id,
        status: !pasteFailed && (outputResult.pasted || outputResult.copied) ? "success" : "failed",
        detail: pasteFailed ? outputResult.pasteError : outputResult.pasted ? "pasted" : "copied"
      }
    };
  } catch (error) {
    return {
      handled: true,
      ack: {
        type: "ack",
        request_id: payload.request_id,
        source_device_id: myDeviceId,
        target_device_id: payload.source_device_id,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

// 心跳默认 25s：跨境路径静默黑洞（server→client 单向断流，2026-09 实测）要等
// 25-60s 才被 phoenix 心跳超时发现。压到 15s 把盲区缩到 15-45s。
const HEARTBEAT_INTERVAL_MS = 15000;

export function createAgentClient({ supabaseUrl, supabaseAnonKey, storage }) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    },
    realtime: {
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS
    }
  });
}

// 连接恢复模型（2026-09-27 重构，根因见 docs/agent-work/cloud-disconnect/）：
// 1. phoenix 自愈优先 —— socket 断开由 realtime-js 的 reconnectTimer 自动重连、
//    errored 通道在 connOpen 后自动 rejoin，我们什么都不做。旧实现里每次
//    CHANNEL_ERROR 都 purge 全部通道再重建，而 purge 的 leave() 又会触发 CLOSED
//    回调排下一轮重连，形成自我维持的风暴（9/26 日志：209 次真实掉线被放大成
//    708 次重连调度，70% 是自己制造）。
// 2. 只有两件事需要人工干预：
//    a) 服务端 phx_close（CLOSED 状态）——phoenix 的 closed 通道永不 rejoin，
//       必须	removeChannel 后重建该通道；
//    b) 看门狗 —— message 通道连续 watchdogUnhealthyMs 不健康，说明 phoenix
//       自愈卡死（如 socket 卡在假在线），做一次全量重建兜底。
// 3. 回声护栏 —— 重建前先把引用置空，旧通道的所有回调因身份不匹配立即失活，
//    purge 触发的 CLOSED 不会再引发任何动作。
const REBUILD_MIN_INTERVAL_MS = 5000;
const WATCHDOG_INTERVAL_MS = 30000;
const WATCHDOG_UNHEALTHY_MS = 150000;

export async function startRealtimeAgent({
  supabase,
  userId,
  device,
  output = outputText,
  onStatus = console.log,
  reportWindowTitles = false,
  windowRefreshMs = 5000,
  appVersion,
  listWindows = listCloudWindows,
  lanEndpoints = [],
  watchdogIntervalMs = WATCHDOG_INTERVAL_MS,
  watchdogUnhealthyMs = WATCHDOG_UNHEALTHY_MS
}) {
  const ackChannels = new Map();
  let messageChannel = null;
  let presence = null;
  let presenceTimer = null;
  let watchdogTimer = null;
  let stopped = false;
  let rebuilding = false;
  let messageHealthy = false;
  let lastHealthyAt = Date.now();
  let includeWindowTitles = Boolean(reportWindowTitles);
  let currentLanEndpoints = normalizeLanEndpoints(lanEndpoints);
  let lastWindowsJson = "";
  const lastRebuildAt = { message: 0, presence: 0 };

  const purgeChannel = async (channel) => {
    try {
      await channel?.unsubscribe();
    } catch {
      // Channel already dead.
    }
    try {
      await supabase.removeChannel?.(channel);
    } catch {
      // removeChannel unavailable (test doubles) or already removed.
    }
  };

  const noteHealth = () => {
    if (stopped) return;
    if (messageHealthy) {
      lastHealthyAt = Date.now();
      onStatus("health:online");
    } else {
      onStatus("health:degraded");
    }
  };

  const trackPresence = async (force = false) => {
    const channel = presence;
    if (!channel) return;
    const windows = await listWindows({ includeTitles: includeWindowTitles });
    const windowsJson = JSON.stringify({ windows, lanEndpoints: currentLanEndpoints });
    if (!force && windowsJson === lastWindowsJson) return;
    lastWindowsJson = windowsJson;
    const payload = {
      deviceId: device.id,
      name: device.name,
      platform: device.platform,
      appVersion,
      protocolVersion: PROTOCOL_VERSION,
      status: "online",
      windows
    };
    if (currentLanEndpoints.length > 0) {
      payload.lanEndpoints = currentLanEndpoints;
    }
    await channel.track(payload);
  };

  const schedulePresenceRefresh = () => {
    clearTimeout(presenceTimer);
    if (stopped) return;
    presenceTimer = setTimeout(async () => {
      presenceTimer = null;
      try {
        await trackPresence();
      } catch (error) {
        onStatus(`presence:windows:${error.message}`);
      } finally {
        schedulePresenceRefresh();
      }
    }, windowRefreshMs);
  };

  const rebuildMessageChannel = async (reason) => {
    if (stopped || rebuilding) return;
    if (Date.now() - lastRebuildAt.message < REBUILD_MIN_INTERVAL_MS) return;
    lastRebuildAt.message = Date.now();
    rebuilding = true;
    const old = messageChannel;
    messageChannel = null;
    messageHealthy = false;
    noteHealth();
    onStatus(`rebuild:message:${reason}`);
    try {
      await purgeChannel(old);
      if (!stopped) await buildMessageChannel();
    } finally {
      rebuilding = false;
    }
  };

  const rebuildPresenceChannel = async (reason) => {
    if (stopped || rebuilding) return;
    if (Date.now() - lastRebuildAt.presence < REBUILD_MIN_INTERVAL_MS) return;
    lastRebuildAt.presence = Date.now();
    rebuilding = true;
    const old = presence;
    presence = null;
    onStatus(`rebuild:presence:${reason}`);
    try {
      await purgeChannel(old);
      if (!stopped) await buildPresenceChannel();
    } finally {
      rebuilding = false;
    }
  };

  const buildMessageChannel = async () => {
    const channel = supabase.channel(deviceChannel(userId, device.id), {
      config: { private: true }
    });
    messageChannel = channel;
    channel.on("broadcast", { event: "command" }, async ({ payload }) => {
      const ackChannelPromise = (
        isInsertTextMessage(payload, device.id) || isKeyMessage(payload, device.id)
      )
        ? getAckChannel(payload.source_device_id)
        : null;
      const result = await handleDesktopMessage({ payload, myDeviceId: device.id, output });
      if (result.ack) {
        const targetDeviceId = result.ack.target_device_id;
        try {
          const ackChannel = await (ackChannelPromise || getAckChannel(targetDeviceId));
          const sendStatus = await ackChannel.send({
            type: "broadcast",
            event: "ack",
            payload: result.ack
          });
          if (sendStatus !== "ok") {
            onStatus(`ack:${targetDeviceId}:${sendStatus}`);
          }
        } catch (error) {
          // 命令已执行（文本已粘贴），只是回执发不出去。绝不能让这个
          // rejection 沉默地炸掉 broadcast 回调——那会让手机端误报失败。
          onStatus(`ack:${targetDeviceId}:${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    await channel.subscribe((status) => {
      // 回声护栏：只有"当前" message 通道的回调才算数。purge 旧通道时
      // leave() 触发的 CLOSED、迟到的事件，都在这里被挡掉。
      if (stopped || channel !== messageChannel) return;
      onStatus(`message:${status}`);
      if (status === "SUBSCRIBED") {
        messageHealthy = true;
        noteHealth();
      } else if (status === "CLOSED") {
        // 服务端 phx_close：closed 通道 phoenix 永不 rejoin，必须重建。
        messageHealthy = false;
        noteHealth();
        void rebuildMessageChannel("server-closed");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        // socket 级异常（心跳超时/断流）。phoenix 自己重连 + rejoin，
        // 恢复后会再次收到 SUBSCRIBED。这里只降级显示，不做任何拆除。
        messageHealthy = false;
        noteHealth();
      }
    });
  };

  const buildPresenceChannel = async () => {
    const channel = supabase.channel(presenceChannel(userId), {
      config: { private: true }
    });
    presence = channel;
    // join 事件的 key 是 Realtime 随机生成的 presence key，每次重连都会变；
    // 真正稳定的对端 ID 在 payload 的 deviceId 里。用 key 预热会在每次
    // 对端重连时创建一个指向不存在设备的新通道，channel join 频率超标后
    // 服务器会断开整个连接，形成每秒重连的死循环。
    channel.on("presence", { event: "join" }, ({ newPresences }) => {
      for (const entry of newPresences ?? []) {
        const deviceId = entry?.deviceId;
        if (deviceId && deviceId !== device.id) {
          warmupAckChannel(deviceId);
        }
      }
    });
    await channel.subscribe(async (status) => {
      if (stopped || channel !== presence) return;
      onStatus(`presence:${status}`);
      if (status === "SUBSCRIBED") {
        await trackPresence(true);
        schedulePresenceRefresh();
      } else if (status === "CLOSED") {
        // 服务端 phx_close —— 重建 presence 通道（不影响 message 传输健康度）。
        void rebuildPresenceChannel("server-closed");
      }
      // CHANNEL_ERROR/TIMED_OUT：phoenix 自动 rejoin，不拆除。
    });
  };

  const fullRebuild = async (reason) => {
    if (stopped || rebuilding) return;
    rebuilding = true;
    onStatus(`rebuild:full:${reason}`);
    try {
      clearTimeout(presenceTimer);
      presenceTimer = null;
      const oldMessage = messageChannel;
      const oldPresence = presence;
      const oldAcks = [...ackChannels.values()];
      messageChannel = null;
      presence = null;
      ackChannels.clear();
      messageHealthy = false;
      // 全部引用先置空再 purge：旧通道回调立即失活，purge 引发的
      // CLOSED/TIMED_OUT 不会触发任何连锁反应。
      await Promise.all([
        purgeChannel(oldMessage),
        purgeChannel(oldPresence),
        ...oldAcks.map(({ channel }) => purgeChannel(channel))
      ]);
      if (stopped) return;
      lastWindowsJson = "";
      await buildMessageChannel();
      await buildPresenceChannel();
      noteHealth();
    } finally {
      rebuilding = false;
    }
  };

  const getAckChannel = async (targetDeviceId) => {
    const existing = ackChannels.get(targetDeviceId);
    if (existing) return await existing.ready;

    const channel = supabase.channel(deviceChannel(userId, targetDeviceId), {
      config: { private: true }
    });
    const entry = {
      channel,
      ready: subscribeRealtimeChannel(channel, `ack:${targetDeviceId}`, onStatus)
        .then(() => channel)
        .catch(async (error) => {
          if (ackChannels.get(targetDeviceId) === entry) {
            ackChannels.delete(targetDeviceId);
          }
          await purgeChannel(channel);
          throw error;
        })
    };
    ackChannels.set(targetDeviceId, entry);
    return await entry.ready;
  };

  const warmupAckChannel = (targetDeviceId) => {
    if (!targetDeviceId || ackChannels.has(targetDeviceId)) return;
    void getAckChannel(targetDeviceId).catch(() => {
      // 预热失败不影响主流程，真正发送时会重试
    });
  };

  // 看门狗：message 通道连续太久不健康（phoenix 自愈应在一两分钟内完成），
  // 说明自愈卡死——socket 假在线、通道对象缓存死亡等。做一次全量重建兜底。
  // 节奏由 watchdogIntervalMs/watchdogUnhealthyMs 控制，慢到不可能自我维持。
  watchdogTimer = setInterval(() => {
    if (stopped) return;
    if (messageHealthy) {
      lastHealthyAt = Date.now();
      return;
    }
    if (Date.now() - lastHealthyAt >= watchdogUnhealthyMs) {
      lastHealthyAt = Date.now();
      void fullRebuild("watchdog");
    }
  }, watchdogIntervalMs);
  watchdogTimer.unref?.();

  await buildMessageChannel();
  await buildPresenceChannel();

  return {
    getHealth() {
      return { online: messageHealthy && !stopped };
    },
    forceReconnect(reason = "manual") {
      void fullRebuild(reason);
    },
    async setReportWindowTitles(enabled) {
      includeWindowTitles = Boolean(enabled);
      lastWindowsJson = "";
      await trackPresence(true);
    },
    async setLanEndpoints(endpoints) {
      currentLanEndpoints = normalizeLanEndpoints(endpoints);
      lastWindowsJson = "";
      await trackPresence(true);
    },
    async stop() {
      stopped = true;
      clearTimeout(presenceTimer);
      clearInterval(watchdogTimer);
      presenceTimer = null;
      await Promise.all([
        purgeChannel(messageChannel),
        purgeChannel(presence),
        ...[...ackChannels.values()].map(({ channel }) => purgeChannel(channel))
      ]);
      ackChannels.clear();
      messageChannel = null;
      presence = null;
    }
  };
}

function normalizeLanEndpoints(endpoints) {
  if (!Array.isArray(endpoints)) return [];
  return endpoints
    .filter((endpoint) => endpoint && typeof endpoint.host === "string" && endpoint.host !== "")
    .map((endpoint) => ({
      host: endpoint.host,
      port: Number(endpoint.port) || 0,
      httpPort: Number(endpoint.httpPort) || 0
    }))
    .filter((endpoint) => endpoint.port > 0 && endpoint.httpPort > 0);
}

function subscribeRealtimeChannel(channel, label, onStatus, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label}:TIMED_OUT`)), timeoutMs);
    try {
      channel.subscribe((status) => {
        onStatus(`${label}:${status}`);
        if (status === "SUBSCRIBED") {
          clearTimeout(timeout);
          resolve();
        } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
          clearTimeout(timeout);
          reject(new Error(`${label}:${status}`));
        }
      });
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}
