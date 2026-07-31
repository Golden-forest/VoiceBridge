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

export async function startRealtimeAgent({
  supabase,
  userId,
  device,
  output = outputText,
  onStatus = console.log,
  reportWindowTitles = false,
  windowRefreshMs = 5000,
  appVersion,
  listWindows = listCloudWindows
}) {
  const ackChannels = new Map();
  const messageChannel = supabase.channel(deviceChannel(userId, device.id), {
    config: { private: true }
  });
  const presence = supabase.channel(presenceChannel(userId), {
    config: { private: true }
  });
  let presenceTimer = null;
  let stopped = false;
  let includeWindowTitles = Boolean(reportWindowTitles);
  let lastWindowsJson = "";

  const trackPresence = async (force = false) => {
    const windows = await listWindows({ includeTitles: includeWindowTitles });
    const windowsJson = JSON.stringify(windows);
    if (!force && windowsJson === lastWindowsJson) return;
    lastWindowsJson = windowsJson;
    await presence.track({
      deviceId: device.id,
      name: device.name,
      platform: device.platform,
      appVersion,
      protocolVersion: PROTOCOL_VERSION,
      status: "online",
      windows
    });
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
          await channel.unsubscribe();
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

  messageChannel.on("broadcast", { event: "command" }, async ({ payload }) => {
    const ackChannelPromise = (
      isInsertTextMessage(payload, device.id) || isKeyMessage(payload, device.id)
    )
      ? getAckChannel(payload.source_device_id)
      : null;
    const result = await handleDesktopMessage({ payload, myDeviceId: device.id, output });
    if (result.ack) {
      const targetDeviceId = result.ack.target_device_id;
      const ackChannel = await (ackChannelPromise || getAckChannel(targetDeviceId));
      const sendStatus = await ackChannel.send({
        type: "broadcast",
        event: "ack",
        payload: result.ack
      });
      if (sendStatus !== "ok") {
        onStatus(`ack:${targetDeviceId}:${sendStatus}`);
      }
    }
  });

  presence.on("presence", { event: "join" }, ({ key }) => {
    if (key && key !== device.id) {
      warmupAckChannel(key);
    }
  });

  await messageChannel.subscribe((status) => onStatus(`message:${status}`));
  await presence.subscribe(async (status) => {
    onStatus(`presence:${status}`);
    if (status === "SUBSCRIBED") {
      await trackPresence(true);
      schedulePresenceRefresh();
    }
  });

  return {
    async setReportWindowTitles(enabled) {
      includeWindowTitles = Boolean(enabled);
      lastWindowsJson = "";
      await trackPresence(true);
    },
    async stop() {
      stopped = true;
      clearTimeout(presenceTimer);
      presenceTimer = null;
      await messageChannel.unsubscribe();
      await presence.unsubscribe();
      await Promise.all(
        [...ackChannels.values()].map(({ channel }) => channel.unsubscribe())
      );
      ackChannels.clear();
    }
  };
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
