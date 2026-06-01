import { deviceChannel, presenceChannel, createRequestId, isAckMessage } from "../shared/protocol.js";

export class CloudRealtime {
  constructor({ supabase, user, phoneDeviceId, onDevices, onAck, onStatus, ackTimeoutMs = 10000, subscribeTimeoutMs = 10000 }) {
    this.supabase = supabase;
    this.user = user;
    this.phoneDeviceId = phoneDeviceId;
    this.onDevices = onDevices;
    this.onAck = onAck;
    this.onStatus = onStatus;
    this.ackTimeoutMs = ackTimeoutMs;
    this.subscribeTimeoutMs = subscribeTimeoutMs;
    this.presence = null;
    this.ackChannel = null;
    this.targetChannels = new Map();
    this.pendingRequests = new Map();
    this.pendingSubscriptions = new Set();
    this.startGeneration = 0;
  }

  async start() {
    await this.stop();
    const generation = ++this.startGeneration;
    this.presence = this.supabase.channel(presenceChannel(this.user.id), {
      config: { private: true }
    });
    this.ackChannel = this.supabase.channel(deviceChannel(this.user.id, this.phoneDeviceId), {
      config: { private: true }
    });
    const presence = this.presence;
    const ackChannel = this.ackChannel;
    this.ackChannel.on("broadcast", { event: "ack" }, ({ payload }) => {
      if (!this.isActiveGeneration(generation)) return;
      if (isAckMessage(payload, this.phoneDeviceId) && this.pendingRequests.has(payload.request_id)) {
        this.clearPendingRequest(payload.request_id);
        this.onAck(payload);
      }
    });
    this.presence.on("presence", { event: "sync" }, () => {
      if (!this.isActiveGeneration(generation)) return;
      const state = presence.presenceState();
      const devices = Object.values(state).flat().filter((entry) => entry.deviceId);
      this.onDevices(devices);
    });
    await this.subscribeChannel(ackChannel, "ack", null, generation);
    await this.subscribeChannel(presence, "presence", async (status) => {
      if (!this.isActiveGeneration(generation)) return;
      this.onStatus(status);
      if (status === "SUBSCRIBED") {
        await presence.track({
          deviceId: this.phoneDeviceId,
          name: "Phone",
          platform: "web",
          runtimePlatform: navigator.platform || "web",
          status: "online"
        });
      }
    }, generation);
  }

  async sendText({ targetDeviceId, text, autoPaste }) {
    if (!this.ackChannel) {
      throw new Error("云端尚未连接");
    }
    const requestId = createRequestId();
    const channel = await this.getTargetChannel(targetDeviceId);
    this.addPendingRequest(requestId, targetDeviceId);
    let sendStatus;
    try {
      sendStatus = await channel.send({
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
    } catch (error) {
      this.clearPendingRequest(requestId);
      throw error;
    }
    if (sendStatus !== "ok") {
      this.clearPendingRequest(requestId);
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

  subscribeChannel(channel, label, onStatus, generation = this.startGeneration) {
    return new Promise((resolve, reject) => {
      const subscription = {
        label,
        settled: false,
        timer: null,
        cancel: null
      };
      const settle = (fn, value) => {
        if (subscription.settled) return;
        subscription.settled = true;
        clearTimeout(subscription.timer);
        this.pendingSubscriptions.delete(subscription);
        fn(value);
      };
      subscription.cancel = () => {
        settle(reject, new Error(`${label} 订阅已取消`));
      };
      subscription.timer = setTimeout(() => {
        if (!this.isActiveGeneration(generation)) {
          settle(reject, new Error(`${label} 订阅已取消`));
          return;
        }
        this.onStatus(`${label}:TIMED_OUT`);
        settle(reject, new Error(`${label} 订阅超时`));
      }, this.subscribeTimeoutMs);
      this.pendingSubscriptions.add(subscription);

      let subscribeResult;
      try {
        subscribeResult = channel.subscribe(async (status) => {
          if (!this.isActiveGeneration(generation)) return;
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

  addPendingRequest(requestId, targetDeviceId) {
    const timer = setTimeout(() => {
      if (!this.pendingRequests.has(requestId)) return;
      this.pendingRequests.delete(requestId);
      this.onStatus(`ack:${requestId}:TIMED_OUT`);
      this.onAck({
        type: "ack",
        request_id: requestId,
        source_device_id: targetDeviceId,
        target_device_id: this.phoneDeviceId,
        status: "failed",
        detail: "桌面端未确认，请确认客户端在线。"
      });
    }, this.ackTimeoutMs);

    this.pendingRequests.set(requestId, { targetDeviceId, timer });
  }

  clearPendingRequest(requestId) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
  }

  isActiveGeneration(generation) {
    return generation === this.startGeneration && Boolean(this.presence && this.ackChannel);
  }

  async stop() {
    this.startGeneration++;
    for (const subscription of [...this.pendingSubscriptions]) {
      subscription.cancel();
    }
    const channels = [
      this.presence,
      this.ackChannel,
      ...this.targetChannels.values()
    ].filter(Boolean);

    await Promise.all(channels.map((channel) => channel.unsubscribe?.()));
    this.presence = null;
    this.ackChannel = null;
    this.targetChannels.clear();
    for (const requestId of this.pendingRequests.keys()) {
      this.clearPendingRequest(requestId);
    }
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
