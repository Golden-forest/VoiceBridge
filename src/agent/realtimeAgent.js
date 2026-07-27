import { createClient } from "@supabase/supabase-js";
import { deviceChannel, presenceChannel, isInsertTextMessage, isKeyMessage } from "../shared/protocol.js";
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
  windowRefreshMs = 2000,
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
      status: "online",
      windows
    });
  };

  messageChannel.on("broadcast", { event: "command" }, async ({ payload }) => {
    console.info("[VB realtime] command received", {
      type: payload?.type,
      key: payload?.key,
      target: payload?.target_device_id,
      myDeviceId: device.id,
      match: payload?.target_device_id === device.id
    });
    const result = await handleDesktopMessage({ payload, myDeviceId: device.id, output });
    console.info("[VB realtime] handleDesktopMessage result", {
      handled: result?.handled,
      ackStatus: result?.ack?.status,
      ackDetail: result?.ack?.detail
    });
    if (result.ack) {
      const targetDeviceId = result.ack.target_device_id;
      let ackChannel = ackChannels.get(targetDeviceId);
      if (!ackChannel) {
        ackChannel = supabase.channel(deviceChannel(userId, targetDeviceId), {
          config: { private: true }
        });
        ackChannels.set(targetDeviceId, ackChannel);
      }

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

  await messageChannel.subscribe((status) => onStatus(`message:${status}`));
  await presence.subscribe(async (status) => {
    onStatus(`presence:${status}`);
    if (status === "SUBSCRIBED") {
      await trackPresence(true);
      presenceTimer = setInterval(() => {
        void trackPresence().catch((error) => onStatus(`presence:windows:${error.message}`));
      }, windowRefreshMs);
    }
  });

  return {
    async setReportWindowTitles(enabled) {
      includeWindowTitles = Boolean(enabled);
      lastWindowsJson = "";
      await trackPresence(true);
    },
    async stop() {
      clearInterval(presenceTimer);
      presenceTimer = null;
      await messageChannel.unsubscribe();
      await presence.unsubscribe();
      await Promise.all(
        [...ackChannels.values()].map((channel) => channel.unsubscribe())
      );
      ackChannels.clear();
    }
  };
}
