import { createClient } from "@supabase/supabase-js";
import { deviceChannel, presenceChannel, isInsertTextMessage } from "../shared/protocol.js";
import { outputText } from "../server/input/outputText.js";

export async function handleDesktopMessage({
  payload,
  myDeviceId,
  output = outputText
}) {
  if (!isInsertTextMessage(payload, myDeviceId)) {
    return { handled: false };
  }

  try {
    const outputResult = await output(payload.text, {
      autoPaste: Boolean(payload.auto_paste)
    });
    return {
      handled: true,
      ack: {
        type: "ack",
        request_id: payload.request_id,
        source_device_id: myDeviceId,
        target_device_id: payload.source_device_id,
        status: outputResult.pasted || outputResult.copied ? "success" : "failed",
        detail: outputResult.pasted ? "pasted" : "copied"
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

export function createAgentClient({ supabaseUrl, supabaseAnonKey }) {
  return createClient(supabaseUrl, supabaseAnonKey);
}

export async function startRealtimeAgent({
  supabase,
  userId,
  device,
  onStatus = console.log
}) {
  const messageChannel = supabase.channel(deviceChannel(userId, device.id), {
    config: { private: true }
  });
  const presence = supabase.channel(presenceChannel(userId), {
    config: { private: true }
  });

  messageChannel.on("broadcast", { event: "command" }, async ({ payload }) => {
    const result = await handleDesktopMessage({ payload, myDeviceId: device.id });
    if (result.ack) {
      await supabase.channel(deviceChannel(userId, result.ack.target_device_id), {
        config: { private: true }
      }).send({
        type: "broadcast",
        event: "ack",
        payload: result.ack
      });
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
    }
  };
}
