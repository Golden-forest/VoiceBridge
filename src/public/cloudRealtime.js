import { deviceChannel, presenceChannel, createRequestId, isAckMessage } from "../shared/protocol.js";

export class CloudRealtime {
  constructor({ supabase, user, phoneDeviceId, onDevices, onAck, onStatus }) {
    this.supabase = supabase;
    this.user = user;
    this.phoneDeviceId = phoneDeviceId;
    this.onDevices = onDevices;
    this.onAck = onAck;
    this.onStatus = onStatus;
    this.presence = null;
    this.ackChannels = new Map();
  }

  async start() {
    this.presence = this.supabase.channel(presenceChannel(this.user.id), {
      config: { private: true }
    });
    this.presence.on("presence", { event: "sync" }, () => {
      const state = this.presence.presenceState();
      const devices = Object.values(state).flat().filter((entry) => entry.deviceId);
      this.onDevices(devices);
    });
    await this.presence.subscribe(async (status) => {
      this.onStatus(status);
      if (status === "SUBSCRIBED") {
        await this.presence.track({
          deviceId: this.phoneDeviceId,
          name: "Phone",
          platform: navigator.platform || "web",
          status: "online"
        });
      }
    });
  }

  async sendText({ targetDeviceId, text, autoPaste }) {
    const requestId = createRequestId();
    const channel = this.supabase.channel(deviceChannel(this.user.id, targetDeviceId), {
      config: { private: true }
    });
    const ackChannel = this.supabase.channel(deviceChannel(this.user.id, this.phoneDeviceId), {
      config: { private: true }
    });
    ackChannel.on("broadcast", { event: "ack" }, ({ payload }) => {
      if (isAckMessage(payload, this.phoneDeviceId) && payload.request_id === requestId) {
        this.onAck(payload);
      }
    });
    await ackChannel.subscribe();
    await channel.subscribe();
    await channel.send({
      type: "broadcast",
      event: "command",
      payload: {
        type: "insert_text",
        request_id: requestId,
        source_device_id: this.phoneDeviceId,
        target_device_id: targetDeviceId,
        text,
        auto_paste: autoPaste,
        created_at: new Date().toISOString()
      }
    });
    return requestId;
  }
}

export function getPhoneDeviceId() {
  const key = "voicebridge_phone_device_id";
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(key, value);
  }
  return value;
}
