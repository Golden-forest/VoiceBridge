import test from "node:test";
import assert from "node:assert/strict";
import { CloudRealtime, getPhoneDeviceId, isDesktopDeviceCandidate } from "./cloudRealtime.js";

test("getPhoneDeviceId reuses a stable localStorage id", () => {
  const values = new Map();
  const originalLocalStorage = globalThis.localStorage;

  globalThis.localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };

  try {
    const deviceId = getPhoneDeviceId();
    assert.equal(typeof deviceId, "string");
    assert.equal(getPhoneDeviceId(), deviceId);
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
});

test("CloudRealtime sends insert text command to target device and listens for matching ack", async () => {
  const channels = new Map();
  const createdTopics = [];
  let ackHandler;
  const unsubscribedTopics = [];

  const supabase = {
    channel(topic) {
      createdTopics.push(topic);
      if (!channels.has(topic)) {
        channels.set(topic, {
          topic,
          sends: [],
          on(type, filter, handler) {
            if (type === "broadcast" && filter.event === "ack") {
              ackHandler = handler;
            }
            return this;
          },
          async subscribe(callback) {
            await callback?.("SUBSCRIBED");
            return "ok";
          },
          async track() {
            return "ok";
          },
          async send(message) {
            this.sends.push(message);
            return "ok";
          },
          async unsubscribe() {
            unsubscribedTopics.push(topic);
            return "ok";
          }
        });
      }
      return channels.get(topic);
    }
  };

  const acks = [];
  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    onDevices: () => {},
    onAck: (ack) => acks.push(ack),
    onStatus: () => {}
  });

  await realtime.start();
  const firstSend = realtime.sendText({
    targetDeviceId: "desktop-1",
    text: "hello",
    autoPaste: true
  });
  await waitFor(() => channels.get("device:user-1:desktop-1")?.sends.length === 1);
  const requestId = channels.get("device:user-1:desktop-1").sends[0].payload.request_id;
  ackHandler({
    payload: {
      type: "ack",
      request_id: requestId,
      source_device_id: "desktop-1",
      target_device_id: "phone-1",
      status: "success"
    }
  });
  assert.equal(await firstSend, requestId);

  const secondSend = realtime.sendText({
    targetDeviceId: "desktop-1",
    text: "again",
    autoPaste: false
  });
  await waitFor(() => channels.get("device:user-1:desktop-1").sends.length === 2);
  const secondRequestId = channels.get("device:user-1:desktop-1").sends[1].payload.request_id;

  assert.equal(createdTopics.includes("device:user-1:desktop-1"), true);
  assert.equal(createdTopics.includes("device:user-1:phone-1"), true);
  assert.equal(createdTopics.filter((topic) => topic === "device:user-1:phone-1").length, 1);
  assert.equal(createdTopics.filter((topic) => topic === "device:user-1:desktop-1").length, 1);
  assert.equal(channels.get("device:user-1:desktop-1").sends[0].event, "command");
  assert.deepEqual(channels.get("device:user-1:desktop-1").sends[0].payload, {
    type: "insert_text",
    request_id: requestId,
    source_device_id: "phone-1",
    target_device_id: "desktop-1",
    text: "hello",
    auto_paste: true,
    created_at: channels.get("device:user-1:desktop-1").sends[0].payload.created_at
  });
  assert.equal(channels.get("device:user-1:desktop-1").sends[1].payload.request_id, secondRequestId);

  ackHandler({
    payload: {
      type: "ack",
      request_id: secondRequestId,
      source_device_id: "desktop-1",
      target_device_id: "phone-1",
      status: "success"
    }
  });
  assert.equal(await secondSend, secondRequestId);

  ackHandler({
    payload: {
      type: "ack",
      request_id: "other-request",
      source_device_id: "desktop-1",
      target_device_id: "phone-1",
      status: "success"
    }
  });

  assert.equal(acks.length, 2);
  assert.equal(acks[0].request_id, requestId);
  assert.equal(acks[1].request_id, secondRequestId);

  await realtime.stop();

  assert.deepEqual(unsubscribedTopics.sort(), [
    "device:user-1:desktop-1",
    "device:user-1:phone-1",
    "user:user-1:presence"
  ].sort());
});

test("CloudRealtime sendText resolves only after a success ack", async () => {
  let ackHandler;
  const supabase = {
    channel() {
      return {
        on(type, filter, handler) {
          if (type === "broadcast" && filter.event === "ack") {
            ackHandler = handler;
          }
          return this;
        },
        async subscribe(callback) {
          await callback?.("SUBSCRIBED");
          return "ok";
        },
        async track() {
          return "ok";
        },
        async send() {
          return "ok";
        },
        async unsubscribe() {
          return "ok";
        }
      };
    }
  };

  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    ackTimeoutMs: 50,
    onDevices: () => {},
    onAck: () => {},
    onStatus: () => {}
  });

  await realtime.start();
  const sendPromise = realtime.sendText({ targetDeviceId: "desktop-1", text: "hello", autoPaste: true });
  const earlyResult = await Promise.race([
    sendPromise.then(() => "resolved"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 10))
  ]);

  assert.equal(earlyResult, "pending");

  const [requestId] = realtime.pendingRequests.keys();
  ackHandler({
    payload: {
      type: "ack",
      request_id: requestId,
      source_device_id: "desktop-1",
      target_device_id: "phone-1",
      status: "success"
    }
  });

  assert.equal(await sendPromise, requestId);
});

test("CloudRealtime sendText rejects on failed ack and keeps onAck notification", async () => {
  let ackHandler;
  const acks = [];
  const supabase = {
    channel() {
      return {
        on(type, filter, handler) {
          if (type === "broadcast" && filter.event === "ack") {
            ackHandler = handler;
          }
          return this;
        },
        async subscribe(callback) {
          await callback?.("SUBSCRIBED");
          return "ok";
        },
        async track() {
          return "ok";
        },
        async send() {
          return "ok";
        },
        async unsubscribe() {
          return "ok";
        }
      };
    }
  };

  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    ackTimeoutMs: 50,
    onDevices: () => {},
    onAck: (ack) => acks.push(ack),
    onStatus: () => {}
  });

  await realtime.start();
  const sendPromise = realtime.sendText({ targetDeviceId: "desktop-1", text: "hello", autoPaste: true });
  const rejection = assert.rejects(sendPromise, /paste failed/);
  await waitFor(() => realtime.pendingRequests.size === 1);
  const [requestId] = realtime.pendingRequests.keys();

  ackHandler({
    payload: {
      type: "ack",
      request_id: requestId,
      source_device_id: "desktop-1",
      target_device_id: "phone-1",
      status: "failed",
      detail: "paste failed"
    }
  });

  await rejection;
  assert.equal(acks.length, 1);
  assert.equal(acks[0].detail, "paste failed");
});

test("CloudRealtime identifies phone browser presence as web", async () => {
  let trackedPresence;

  const supabase = {
    channel() {
      return {
        on() {
          return this;
        },
        async subscribe(callback) {
          await callback?.("SUBSCRIBED");
          return "ok";
        },
        async track(presence) {
          trackedPresence = presence;
          return "ok";
        }
      };
    }
  };

  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    onDevices: () => {},
    onAck: () => {},
    onStatus: () => {}
  });

  await realtime.start();

  assert.equal(trackedPresence.deviceId, "phone-1");
  assert.equal(trackedPresence.platform, "web");
});

test("isDesktopDeviceCandidate excludes web devices and the current phone", () => {
  assert.equal(isDesktopDeviceCandidate({ deviceId: "phone-1", platform: "iPhone" }, "phone-1"), false);
  assert.equal(isDesktopDeviceCandidate({ deviceId: "phone-2", platform: "web" }, "phone-1"), false);
  assert.equal(isDesktopDeviceCandidate({ deviceId: "desktop-1", platform: "darwin" }, "phone-1"), true);
});

test("CloudRealtime ignores ack messages without a pending request", async () => {
  let ackHandler;

  const supabase = {
    channel() {
      return {
        on(type, filter, handler) {
          if (type === "broadcast" && filter.event === "ack") {
            ackHandler = handler;
          }
          return this;
        },
        async subscribe(callback) {
          await callback?.("SUBSCRIBED");
          return "ok";
        },
        async track() {
          return "ok";
        },
        async unsubscribe() {
          return "ok";
        }
      };
    }
  };

  const acks = [];
  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    onDevices: () => {},
    onAck: (ack) => acks.push(ack),
    onStatus: () => {}
  });

  await realtime.start();
  ackHandler({
    payload: {
      type: "ack",
      request_id: "not-pending",
      source_device_id: "desktop-1",
      target_device_id: "phone-1",
      status: "success"
    }
  });

  assert.equal(acks.length, 0);
});

test("CloudRealtime throws when command send returns a non-ok status", async () => {
  const supabase = {
    channel(topic) {
      return {
        topic,
        on() {
          return this;
        },
        async subscribe(callback) {
          await callback?.("SUBSCRIBED");
          return "ok";
        },
        async track() {
          return "ok";
        },
        async send() {
          return topic.includes("desktop-1") ? "error" : "ok";
        },
        async unsubscribe() {
          return "ok";
        }
      };
    }
  };

  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    onDevices: () => {},
    onAck: () => {},
    onStatus: () => {}
  });

  await realtime.start();

  await assert.rejects(
    realtime.sendText({ targetDeviceId: "desktop-1", text: "hello", autoPaste: true }),
    /发送到桌面端失败：error/
  );
});

test("CloudRealtime throws when a channel subscription fails", async () => {
  const statuses = [];
  const supabase = {
    channel(topic) {
      return {
        topic,
        on() {
          return this;
        },
        async subscribe(callback) {
          await callback?.(topic.includes("desktop-1") ? "CHANNEL_ERROR" : "SUBSCRIBED");
          return "ok";
        },
        async track() {
          return "ok";
        },
        async unsubscribe() {
          return "ok";
        }
      };
    }
  };

  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    onDevices: () => {},
    onAck: () => {},
    onStatus: (status) => statuses.push(status)
  });

  await realtime.start();

  await assert.rejects(
    realtime.sendText({ targetDeviceId: "desktop-1", text: "hello", autoPaste: true }),
    /device:desktop-1 订阅失败：CHANNEL_ERROR/
  );
  assert.equal(statuses.includes("device:desktop-1:CHANNEL_ERROR"), true);
});

test("CloudRealtime emits failed ack and clears pending request on ack timeout", async () => {
  const supabase = {
    channel(topic) {
      return {
        topic,
        on() {
          return this;
        },
        async subscribe(callback) {
          await callback?.("SUBSCRIBED");
          return "ok";
        },
        async track() {
          return "ok";
        },
        async send() {
          return "ok";
        },
        async unsubscribe() {
          return "ok";
        }
      };
    }
  };

  const acks = [];
  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    ackTimeoutMs: 5,
    onDevices: () => {},
    onAck: (ack) => acks.push(ack),
    onStatus: () => {}
  });

  await realtime.start();
  const sendPromise = realtime.sendText({ targetDeviceId: "desktop-1", text: "hello", autoPaste: true });
  const rejection = assert.rejects(sendPromise, /桌面端未确认/);
  await waitFor(() => realtime.pendingRequests.size === 1);
  const [requestId] = realtime.pendingRequests.keys();
  await new Promise((resolve) => setTimeout(resolve, 20));

  await rejection;
  assert.equal(acks.length, 1);
  assert.equal(acks[0].request_id, requestId);
  assert.equal(acks[0].status, "failed");
  assert.equal(acks[0].detail, "桌面端未确认，请确认客户端在线。");
  assert.equal(realtime.pendingRequests.size, 0);
});

test("CloudRealtime clears pending request and does not emit timeout ack when send throws", async () => {
  const supabase = {
    channel(topic) {
      return {
        topic,
        on() {
          return this;
        },
        async subscribe(callback) {
          await callback?.("SUBSCRIBED");
          return "ok";
        },
        async track() {
          return "ok";
        },
        async send() {
          if (topic.includes("desktop-1")) {
            throw new Error("network down");
          }
          return "ok";
        },
        async unsubscribe() {
          return "ok";
        }
      };
    }
  };

  const acks = [];
  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    ackTimeoutMs: 5,
    onDevices: () => {},
    onAck: (ack) => acks.push(ack),
    onStatus: () => {}
  });

  await realtime.start();
  await assert.rejects(
    realtime.sendText({ targetDeviceId: "desktop-1", text: "hello", autoPaste: true }),
    /network down/
  );
  assert.equal(realtime.pendingRequests.size, 0);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(acks.length, 0);
});

test("CloudRealtime stop prevents delayed start callbacks from tracking presence", async () => {
  const callbacks = [];
  let tracked = false;

  const supabase = {
    channel() {
      return {
        on() {
          return this;
        },
        subscribe(callback) {
          callbacks.push(callback);
          return "ok";
        },
        async track() {
          tracked = true;
          return "ok";
        },
        async unsubscribe() {
          return "ok";
        }
      };
    }
  };

  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    onDevices: () => {},
    onAck: () => {},
    onStatus: () => {}
  });

  await realtime.start();
  await realtime.stop();
  await Promise.all(callbacks.map((callback) => callback("SUBSCRIBED")));

  assert.equal(tracked, false);
});

test("CloudRealtime stop cancels stale subscription timeout without status mutation", async () => {
  const statuses = [];
  const supabase = {
    channel() {
      return {
        on() {
          return this;
        },
        subscribe() {
          return undefined;
        },
        async unsubscribe() {
          return "ok";
        }
      };
    }
  };

  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    subscribeTimeoutMs: 5,
    onDevices: () => {},
    onAck: () => {},
    onStatus: (status) => statuses.push(status)
  });

  const startPromise = realtime.start();
  await new Promise((resolve) => setTimeout(resolve, 1));
  await realtime.stop();

  await startPromise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(statuses, []);
});

test("CloudRealtime rebuilds core channels after a subscribed channel closes", async () => {
  const callbacks = new Map();
  const createdTopics = [];
  const supabase = {
    channel(topic) {
      createdTopics.push(topic);
      const channel = {
        on() {
          return this;
        },
        async subscribe(callback) {
          callbacks.set(`${topic}:${createdTopics.length}`, callback);
          await callback?.("SUBSCRIBED");
          return "ok";
        },
        async track() {
          return "ok";
        },
        presenceState() {
          return {};
        },
        async unsubscribe() {
          return "ok";
        }
      };
      return channel;
    },
    async removeChannel() {
      return "ok";
    }
  };

  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    reconnectBackoffMs: [1],
    onDevices: () => {},
    onAck: () => {},
    onStatus: () => {}
  });

  await realtime.start();
  const firstPresenceCallback = [...callbacks.entries()]
    .find(([key]) => key.startsWith("user:user-1:presence:"))[1];
  await firstPresenceCallback("CLOSED");
  await waitFor(() => createdTopics.filter((topic) => topic === "user:user-1:presence").length === 2);

  assert.equal(createdTopics.filter((topic) => topic === "device:user-1:phone-1").length, 2);
  await realtime.stop();
});

test("CloudRealtime keeps retrying when the first connection attempt fails", async () => {
  let ackAttempts = 0;
  const statuses = [];
  const supabase = {
    channel(topic) {
      return {
        on() {
          return this;
        },
        async subscribe(callback) {
          if (topic === "device:user-1:phone-1") {
            ackAttempts += 1;
            await callback?.(ackAttempts === 1 ? "CHANNEL_ERROR" : "SUBSCRIBED");
          } else {
            await callback?.("SUBSCRIBED");
          }
          return "ok";
        },
        async track() {
          return "ok";
        },
        presenceState() {
          return {};
        },
        async unsubscribe() {
          return "ok";
        }
      };
    },
    async removeChannel() {
      return "ok";
    }
  };

  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    reconnectBackoffMs: [1],
    onDevices: () => {},
    onAck: () => {},
    onStatus: (status) => statuses.push(status)
  });

  await realtime.start();
  await waitFor(() => ackAttempts === 2);

  assert.equal(statuses.includes("ack:CHANNEL_ERROR"), true);
  assert.equal(statuses.includes("SUBSCRIBED"), true);
  await realtime.stop();
});

async function waitFor(predicate, timeoutMs = 100) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("CloudRealtime timeout ack for key commands carries the key metadata", async () => {
  const supabase = {
    channel() {
      return {
        topic: "t",
        on() { return this; },
        async subscribe(callback) { await callback?.("SUBSCRIBED"); return "ok"; },
        async track() { return "ok"; },
        async send() { return "ok"; },
        async unsubscribe() { return "ok"; }
      };
    }
  };

  const acks = [];
  const realtime = new CloudRealtime({
    supabase,
    user: { id: "user-1" },
    phoneDeviceId: "phone-1",
    ackTimeoutMs: 5,
    onDevices: () => {},
    onAck: (ack) => acks.push(ack),
    onStatus: () => {}
  });

  await realtime.start();
  const sendPromise = realtime.sendKey({ targetDeviceId: "desktop-1", key: "enter" });
  const rejection = assert.rejects(sendPromise, /桌面端未确认/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await rejection;

  // 超时合成的 ack 必须带 key：手机端 onAck 据此走按键分支（触感反馈），
  // 不会误入文本分支双弹 toast。
  assert.equal(acks.length, 1);
  assert.equal(acks[0].key, "enter");
  assert.equal(acks[0].status, "failed");
});
