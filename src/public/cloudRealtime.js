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
    this.ackChannel = null;
    this.targetChannels = new Map();
    this.pendingRequestIds = new Set();
  }

  async start() {
    await this.stop();
    this.presence = this.supabase.channel(presenceChannel(this.user.id), {
      config: { private: true }
    });
    this.ackChannel = this.supabase.channel(deviceChannel(this.user.id, this.phoneDeviceId), {
      config: { private: true }
    });
    this.ackChannel.on("broadcast", { event: "ack" }, ({ payload }) => {
      if (isAckMessage(payload, this.phoneDeviceId) && this.pendingRequestIds.has(payload.request_id)) {
        this.pendingRequestIds.delete(payload.request_id);
        this.onAck(payload);
      }
    });
    this.presence.on("presence", { event: "sync" }, () => {
      const state = this.presence.presenceState();
      const devices = Object.values(state).flat().filter((entry) => entry.deviceId);
      this.onDevices(devices);
    });
    await this.subscribeChannel(this.ackChannel, "ack");
    await this.subscribeChannel(this.presence, "presence", async (status) => {
      this.onStatus(status);
      if (status === "SUBSCRIBED") {
        await this.presence.track({
          deviceId: this.phoneDeviceId,
          name: "Phone",
          platform: "web",
          runtimePlatform: navigator.platform || "web",
          status: "online"
        });
      }
    });
  }

  async sendText({ targetDeviceId, text, autoPaste }) {
    if (!this.ackChannel) {
      throw new Error("云端尚未连接");
    }
    const requestId = createRequestId();
    const channel = await this.getTargetChannel(targetDeviceId);
    this.pendingRequestIds.add(requestId);
    const sendStatus = await channel.send({
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
    if (sendStatus !== "ok") {
      this.pendingRequestIds.delete(requestId);
      throw new Error(`发送到桌面端失败：${sendStatus}`);
    }
    return requestId;
  }

  async getTargetChannel(targetDeviceId) {
    let channel = this.targetChannels.get(targetDeviceId);
    if (channel) return channel;

    channel = this.supabase.channel(deviceChannel(this.user.id, targetDeviceId), {
      config: { private: true }
    });
    this.targetChannels.set(targetDeviceId, channel);
    try {
      await this.subscribeChannel(channel, `device:${targetDeviceId}`);
      return channel;
    } catch (error) {
      this.targetChannels.delete(targetDeviceId);
      throw error;
    }
  }

  subscribeChannel(channel, label, onStatus) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        this.onStatus(`${label}:TIMED_OUT`);
        settle(reject, new Error(`${label} 订阅超时`));
      }, 10000);

      let subscribeResult;
      try {
        subscribeResult = channel.subscribe(async (status) => {
          await onStatus?.(status);
          if (status === "SUBSCRIBED") {
            settle(resolve);
            return;
          }
          if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
            this.onStatus(`${label}:${status}`);
            settle(reject, new Error(`${label} 订阅失败：${status}`));
          }
        });
      } catch (error) {
        settle(reject, error);
        return;
      }

      if (subscribeResult?.then) {
        subscribeResult.then((status) => {
          if (status === "ok") settle(resolve);
          else if (typeof status === "string") settle(reject, new Error(`${label} 订阅失败：${status}`));
        }).catch((error) => settle(reject, error));
      } else if (typeof subscribeResult === "string") {
        if (subscribeResult === "ok") settle(resolve);
        else settle(reject, new Error(`${label} 订阅失败：${subscribeResult}`));
      }
    });
  }

  async stop() {
    const channels = [
      this.presence,
      this.ackChannel,
      ...this.targetChannels.values()
    ].filter(Boolean);

    await Promise.all(channels.map((channel) => channel.unsubscribe?.()));
    this.presence = null;
    this.ackChannel = null;
    this.targetChannels.clear();
    this.pendingRequestIds.clear();
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

export function isDesktopDeviceCandidate(device, phoneDeviceId) {
  return Boolean(
    device?.deviceId &&
    device.deviceId !== phoneDeviceId &&
    device.platform !== "web"
  );
}
