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

export function createAgentClient({ supabaseUrl, supabaseAnonKey, storage }) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });
}

// realtime-js 的 channel 一旦进入 CLOSED 状态永不 rejoin；errored 状态下
// subscribe() 是 no-op 且 supabase.channel(topic) 会返回缓存里的死对象。
// 所以通道死亡时必须 removeChannel 后整体重建，否则桌面端"掉线直到重启"。
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000];
const FATAL_CHANNEL_STATUSES = ["CHANNEL_ERROR", "CLOSED"];

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
  lanEndpoints = []
}) {
  const ackChannels = new Map();
  let messageChannel = supabase.channel(deviceChannel(userId, device.id), {
    config: { private: true }
  });
  let presence = supabase.channel(presenceChannel(userId), {
    config: { private: true }
  });
  let presenceTimer = null;
  let stopped = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnectGeneration = 0;
  let messageHealthy = false;
  let presenceHealthy = false;
  let includeWindowTitles = Boolean(reportWindowTitles);
  let currentLanEndpoints = normalizeLanEndpoints(lanEndpoints);
  let lastWindowsJson = "";

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

  const scheduleReconnect = (reason) => {
    if (stopped) return;
    if (reconnectTimer) return;
    const generation = ++reconnectGeneration;
    const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    reconnectAttempt += 1;
    onStatus(`reconnect:scheduled:${reason}:${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnect(generation);
    }, delay);
  };

  const reconnect = async (generation) => {
    if (stopped || generation !== reconnectGeneration) return;
    messageHealthy = false;
    presenceHealthy = false;
    clearTimeout(presenceTimer);
    presenceTimer = null;
    await Promise.all([...ackChannels.keys()].map((targetId) => {
      const entry = ackChannels.get(targetId);
      ackChannels.delete(targetId);
      return purgeChannel(entry?.channel);
    }));
    await purgeChannel(messageChannel);
    await purgeChannel(presence);
    messageChannel = supabase.channel(deviceChannel(userId, device.id), {
      config: { private: true }
    });
    presence = supabase.channel(presenceChannel(userId), {
      config: { private: true }
    });
    bindCoreChannels();
    await subscribeCoreChannels();
  };

  const noteChannelHealth = () => {
    if (messageHealthy && presenceHealthy && reconnectAttempt > 0) {
      onStatus("reconnect:recovered");
    }
    if (messageHealthy && presenceHealthy) {
      reconnectAttempt = 0;
    }
    onStatus(`health:${messageHealthy && presenceHealthy ? "online" : "degraded"}`);
  };

  const trackPresence = async (force = false) => {
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
    await presence.track(payload);
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

  const bindCoreChannels = () => {
    messageChannel.on("broadcast", { event: "command" }, async ({ payload }) => {
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

    // join 事件的 key 是 Realtime 随机生成的 presence key，每次重连都会变；
    // 真正稳定的对端 ID 在 payload 的 deviceId 里。用 key 预热会在每次
    // 对端重连时创建一个指向不存在设备的新通道，channel join 频率超标后
    // 服务器会断开整个连接，形成每秒重连的死循环。
    presence.on("presence", { event: "join" }, ({ newPresences }) => {
      for (const entry of newPresences ?? []) {
        const deviceId = entry?.deviceId;
        if (deviceId && deviceId !== device.id) {
          warmupAckChannel(deviceId);
        }
      }
    });
  };

  const subscribeCoreChannels = async () => {
    await messageChannel.subscribe((status) => {
      onStatus(`message:${status}`);
      if (status === "SUBSCRIBED") {
        messageHealthy = true;
        noteChannelHealth();
      } else if (FATAL_CHANNEL_STATUSES.includes(status)) {
        messageHealthy = false;
        scheduleReconnect(`message:${status}`);
      }
    });
    await presence.subscribe(async (status) => {
      onStatus(`presence:${status}`);
      if (status === "SUBSCRIBED") {
        presenceHealthy = true;
        noteChannelHealth();
        await trackPresence(true);
        schedulePresenceRefresh();
      } else if (FATAL_CHANNEL_STATUSES.includes(status)) {
        presenceHealthy = false;
        noteChannelHealth();
        scheduleReconnect(`presence:${status}`);
      }
    });
  };

  bindCoreChannels();
  await subscribeCoreChannels();

  return {
    getHealth() {
      return { online: messageHealthy && presenceHealthy && !stopped };
    },
    forceReconnect(reason = "manual") {
      scheduleReconnect(reason);
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
      reconnectGeneration += 1;
      clearTimeout(presenceTimer);
      clearTimeout(reconnectTimer);
      presenceTimer = null;
      reconnectTimer = null;
      await Promise.all([
        purgeChannel(messageChannel),
        purgeChannel(presence),
        ...[...ackChannels.values()].map(({ channel }) => purgeChannel(channel))
      ]);
      ackChannels.clear();
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
