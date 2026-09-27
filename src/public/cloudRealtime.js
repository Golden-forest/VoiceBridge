import {
  PROTOCOL_VERSION,
  deviceChannel,
  presenceChannel,
  createRequestId,
  isAckMessage,
  buildKeyMessage,
  ALLOWED_KEYS
} from "../shared/protocol.js";

// 连接恢复模型（2026-09-27 重构，根因见 docs/agent-work/cloud-disconnect/）：
// 1. phoenix 自愈优先 —— CHANNEL_ERROR/TIMED_OUT（socket 级异常，如跨境路径
//    静默黑洞）由 realtime-js 自动重连 + rejoin，我们只上报状态、绝不拆通道。
//    旧实现任一核心通道 fatal 就全量 teardown（含健康的发送通道），把一次
//    presence 波动放大成"整个云传输不可用"。
// 2. 只有服务端 phx_close（CLOSED，phoenix 永不 rejoin）才重建该通道，
//    且只重建被关的那一个。
// 3. 回声护栏 —— 重建前先把引用置空，旧通道的回调因身份不匹配立即失活，
//    purge 触发的 CLOSED 不会引发连锁反应。
// 4. stop()/reconnectNow()（用户驱动：退出登录、切前台）才做全量重建。
const REBUILD_MIN_INTERVAL_MS = 5000;

export class CloudRealtime {
  constructor({
    supabase,
    user,
    phoneDeviceId,
    onDevices,
    onAck,
    onStatus,
    ackTimeoutMs = 10000,
    subscribeTimeoutMs = 10000
  }) {
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
    this.presenceSubscribed = false;
    this.ackSubscribed = false;
    this.stopped = true;
    this.lastCoreRebuildAt = { presence: 0, ack: 0 };
  }

  async start() {
    await this.stop();
    this.stopped = false;
    // 不等待订阅结果、不抛错：瞬时失败由 phoenix 自动重试，恢复后状态回调
    // 会补报 SUBSCRIBED。把启动期超时当致命错误会误杀整个云端会话。
    await this.buildPresenceChannel();
    await this.buildAckChannel();
  }

  reportCoreStatus() {
    if (this.presenceSubscribed && this.ackSubscribed) {
      this.onStatus("SUBSCRIBED");
    }
  }

  async buildPresenceChannel() {
    const presence = this.supabase.channel(presenceChannel(this.user.id), {
      config: { private: true }
    });
    this.presence = presence;
    presence.on("presence", { event: "sync" }, () => {
      if (this.stopped || presence !== this.presence) return;
      const state = presence.presenceState();
      const devices = Object.values(state).flat().filter((entry) => entry.deviceId);
      this.onDevices(devices);
      // 预热：为桌面设备预订阅目标通道，避免首次发送时冷启动延迟
      for (const device of devices) {
        if (device.deviceId && device.deviceId !== this.phoneDeviceId && device.platform !== "web") {
          this.warmupTargetChannel(device.deviceId);
        }
      }
    });
    await presence.subscribe(async (status) => {
      if (this.stopped || presence !== this.presence) return;
      this.onStatus(`presence:${status}`);
      if (status === "SUBSCRIBED") {
        this.presenceSubscribed = true;
        this.reportCoreStatus();
        await presence.track({
          deviceId: this.phoneDeviceId,
          name: "Phone",
          platform: "web",
          runtimePlatform: navigator.platform || "web",
          protocolVersion: PROTOCOL_VERSION,
          status: "online"
        });
      } else if (status === "CLOSED") {
        // 服务端 phx_close：closed 通道 phoenix 永不 rejoin，重建它。
        this.presenceSubscribed = false;
        void this.rebuildCoreChannel("presence");
      } else {
        // CHANNEL_ERROR / TIMED_OUT：phoenix 自动 rejoin，恢复后会再报
        // SUBSCRIBED。presence 波动不影响发送通道。
        this.presenceSubscribed = false;
      }
    });
  }

  async buildAckChannel() {
    const ackChannel = this.supabase.channel(deviceChannel(this.user.id, this.phoneDeviceId), {
      config: { private: true }
    });
    this.ackChannel = ackChannel;
    ackChannel.on("broadcast", { event: "ack" }, ({ payload }) => {
      if (this.stopped || ackChannel !== this.ackChannel) return;
      if (isAckMessage(payload, this.phoneDeviceId) && this.pendingRequests.has(payload.request_id)) {
        try {
          this.onAck(payload);
        } catch (error) {
          console.error("Cloud ack handler failed:", error);
        }
        if (payload.status === "success") {
          this.resolvePendingRequest(payload.request_id);
        } else {
          this.rejectPendingRequest(payload.request_id, new Error(payload.detail || "桌面端执行失败。"));
        }
      }
    });
    await ackChannel.subscribe((status) => {
      if (this.stopped || ackChannel !== this.ackChannel) return;
      this.onStatus(`ack:${status}`);
      if (status === "SUBSCRIBED") {
        this.ackSubscribed = true;
        this.reportCoreStatus();
      } else if (status === "CLOSED") {
        this.ackSubscribed = false;
        void this.rebuildCoreChannel("ack");
      } else {
        this.ackSubscribed = false;
      }
    });
  }

  async rebuildCoreChannel(kind) {
    if (this.stopped) return;
    if (Date.now() - this.lastCoreRebuildAt[kind] < REBUILD_MIN_INTERVAL_MS) return;
    this.lastCoreRebuildAt[kind] = Date.now();
    // 先置空引用再 purge：旧通道的回声（leave 触发的 CLOSED）全部失活。
    const old = kind === "presence" ? this.presence : this.ackChannel;
    if (kind === "presence") this.presence = null;
    else this.ackChannel = null;
    this.onStatus(`rebuild:${kind}:server-closed`);
    await this.purgeChannel(old);
    if (this.stopped) return;
    await (kind === "presence" ? this.buildPresenceChannel() : this.buildAckChannel());
  }

  async purgeChannel(channel) {
    if (!channel) return;
    try {
      await channel.unsubscribe?.();
    } catch {
      // Channel already dead.
    }
    try {
      await this.supabase.removeChannel?.(channel);
    } catch {
      // removeChannel unavailable or already removed.
    }
  }

  reconnectNow() {
    if (this.stopped) return;
    void this.rebuildAllChannels("reconnect-now");
  }

  async rebuildAllChannels(reason) {
    if (this.stopped) return;
    this.onStatus(`rebuild:all:${reason}`);
    const oldPresence = this.presence;
    const oldAck = this.ackChannel;
    const oldTargets = [...this.targetChannels.values()];
    this.presence = null;
    this.ackChannel = null;
    this.targetChannels.clear();
    this.presenceSubscribed = false;
    this.ackSubscribed = false;
    await Promise.all([
      this.purgeChannel(oldPresence),
      this.purgeChannel(oldAck),
      ...oldTargets.map((channel) => this.purgeChannel(channel))
    ]);
    if (this.stopped) return;
    await this.buildPresenceChannel();
    await this.buildAckChannel();
  }

  async sendText({ targetDeviceId, text, autoPaste, targetWindowId }) {
    if (!this.ackChannel) {
      throw new Error("云端尚未连接");
    }
    const requestId = createRequestId();
    const channel = await this.getTargetChannel(targetDeviceId);
    const ackPromise = this.addPendingRequest(requestId, targetDeviceId);
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
          created_at: new Date().toISOString(),
          ...(targetWindowId ? { target_window_id: targetWindowId } : {})
        }
      });
    } catch (error) {
      this.clearPendingRequest(requestId);
      throw error;
    }
    if (sendStatus !== "ok") {
      const error = new Error(`发送到桌面端失败：${sendStatus}`);
      this.clearPendingRequest(requestId);
      throw error;
    }
    return await ackPromise;
  }

  async sendKey({ targetDeviceId, key, targetWindowId }) {
    if (!this.ackChannel) {
      throw new Error("云端尚未连接");
    }
    if (!ALLOWED_KEYS.includes(key)) {
      throw new Error(`不支持的按键：${key}`);
    }
    const message = buildKeyMessage({
      sourceDeviceId: this.phoneDeviceId,
      targetDeviceId,
      key,
      targetWindowId
    });
    const channel = await this.getTargetChannel(targetDeviceId);
    if (!channel) {
      throw new Error(`未找到桌面端通道：${targetDeviceId}`);
    }
    const payload = {
      ...message,
      created_at: new Date().toISOString()
    };
    const ackPromise = this.addPendingRequest(message.request_id, targetDeviceId, { key });
    let sendStatus;
    try {
      sendStatus = await channel.send({
        type: "broadcast",
        event: "command",
        payload
      });
    } catch (error) {
      this.clearPendingRequest(message.request_id);
      throw error;
    }
    if (sendStatus !== "ok") {
      this.clearPendingRequest(message.request_id);
      throw new Error(`发送到桌面端失败：${sendStatus}`);
    }
    return await ackPromise;
  }

  warmupTargetChannel(targetDeviceId) {
    if (this.targetChannels.has(targetDeviceId)) return;
    void this.getTargetChannel(targetDeviceId).catch(() => {
      // 预热失败不影响主流程，真正发送时会重试
    });
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
      await this.purgeChannel(channel);
      throw error;
    }
  }

  subscribeChannel(channel, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onStatus(`${label}:TIMED_OUT`);
        reject(new Error(`${label} 订阅超时`));
      }, this.subscribeTimeoutMs);

      let subscribeResult;
      try {
        subscribeResult = channel.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timer);
            resolve();
            return;
          }
          if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
            clearTimeout(timer);
            this.onStatus(`${label}:${status}`);
            reject(new Error(`${label} 订阅失败：${status}`));
          }
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }

      if (subscribeResult?.then) {
        subscribeResult.then((status) => {
          if (status === "ok") {
            clearTimeout(timer);
            resolve();
          } else if (typeof status === "string") {
            clearTimeout(timer);
            reject(new Error(`${label} 订阅失败：${status}`));
          }
        }).catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
      } else if (typeof subscribeResult === "string") {
        clearTimeout(timer);
        if (subscribeResult === "ok") resolve();
        else reject(new Error(`${label} 订阅失败：${subscribeResult}`));
      }
    });
  }

  addPendingRequest(requestId, targetDeviceId, meta = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingRequests.has(requestId)) return;
        this.pendingRequests.delete(requestId);
        this.onStatus(`ack:${requestId}:TIMED_OUT`);
        const ack = {
          type: "ack",
          request_id: requestId,
          source_device_id: targetDeviceId,
          target_device_id: this.phoneDeviceId,
          status: "failed",
          detail: "桌面端未确认，请确认客户端在线。",
          // 展开请求元数据（如按键指令的 key）：超时合成的 ack 走与真实 ack
          // 相同的分支，按键超时不会误入文本 ack 路径双弹 toast。
          ...meta
        };
        try {
          this.onAck(ack);
        } catch (error) {
          console.error("Cloud ack handler failed:", error);
        }
        reject(new Error(ack.detail));
      }, this.ackTimeoutMs);

      this.pendingRequests.set(requestId, { targetDeviceId, timer, resolve, reject });
    });
  }

  resolvePendingRequest(requestId) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    this.clearPendingRequest(requestId);
    pending.resolve(requestId);
  }

  rejectPendingRequest(requestId, error) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    this.clearPendingRequest(requestId);
    pending.reject(error);
  }

  cancelPendingRequest(requestId) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    this.clearPendingRequest(requestId);
    pending.reject(new Error("云端连接已关闭"));
  }

  clearPendingRequest(requestId) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
  }

  async stop() {
    this.stopped = true;
    const channels = [
      this.presence,
      this.ackChannel,
      ...this.targetChannels.values()
    ].filter(Boolean);

    this.presence = null;
    this.ackChannel = null;
    this.targetChannels.clear();
    this.presenceSubscribed = false;
    this.ackSubscribed = false;
    await Promise.all(channels.map((channel) => this.purgeChannel(channel)));
    for (const requestId of [...this.pendingRequests.keys()]) {
      this.cancelPendingRequest(requestId);
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
