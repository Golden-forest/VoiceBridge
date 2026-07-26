import { createClient } from "@supabase/supabase-js";
import { deviceChannel, presenceChannel, isInsertTextMessage, isKeyMessage } from "../shared/protocol.js";
import { outputText } from "../server/input/outputText.js";
import { pasteClipboard, pressEnter, pressEscape, pressUndo, pressDelete } from "../server/input/paste.js";

export async function handleDesktopMessage({
  payload,
  myDeviceId,
  output = outputText
}) {
  if (isKeyMessage(payload, myDeviceId)) {
    const { key, request_id, source_device_id } = payload;
    try {
      switch (key) {
        case "paste": await pasteClipboard(); break;
        case "enter": await pressEnter(); break;
        case "escape": await pressEscape(); break;
        case "undo": await pressUndo(); break;
        case "delete": await pressDelete(); break;
      }
      return {
        handled: true,
        ack: {
          type: "ack",
          request_id,
          source_device_id: myDeviceId,
          target_device_id: source_device_id,
          status: "success",
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
          detail: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  if (!isInsertTextMessage(payload, myDeviceId)) {
    return { handled: false };
  }

  try {
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
  onStatus = console.log
}) {
  const ackChannels = new Map();
  const messageChannel = supabase.channel(deviceChannel(userId, device.id), {
    config: { private: true }
  });
  const presence = supabase.channel(presenceChannel(userId), {
    config: { private: true }
  });

  messageChannel.on("broadcast", { event: "command" }, async ({ payload }) => {
    const result = await handleDesktopMessage({ payload, myDeviceId: device.id, output });
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
      await presence.track({
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
        status: "online"
      });
    }
  });

  return {
    async stop() {
      await messageChannel.unsubscribe();
      await presence.unsubscribe();
      await Promise.all(
        [...ackChannels.values()].map((channel) => channel.unsubscribe())
      );
      ackChannels.clear();
    }
  };
}
