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
  const requestId = await realtime.sendText({
    targetDeviceId: "desktop-1",
    text: "hello",
    autoPaste: true
  });
  const secondRequestId = await realtime.sendText({
    targetDeviceId: "desktop-1",
    text: "again",
    autoPaste: false
  });

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
      request_id: requestId,
      source_device_id: "desktop-1",
      target_device_id: "phone-1",
      status: "success"
    }
  });
  ackHandler({
    payload: {
      type: "ack",
      request_id: "other-request",
      source_device_id: "desktop-1",
      target_device_id: "phone-1",
      status: "success"
    }
  });

  assert.equal(acks.length, 1);
  assert.equal(acks[0].request_id, requestId);

  await realtime.stop();

  assert.deepEqual(unsubscribedTopics.sort(), [
    "device:user-1:desktop-1",
    "device:user-1:phone-1",
    "user:user-1:presence"
  ].sort());
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
