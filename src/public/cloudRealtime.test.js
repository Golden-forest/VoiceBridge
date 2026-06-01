import test from "node:test";
import assert from "node:assert/strict";
import { CloudRealtime, getPhoneDeviceId } from "./cloudRealtime.js";

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
          async send(message) {
            this.sends.push(message);
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

  const requestId = await realtime.sendText({
    targetDeviceId: "desktop-1",
    text: "hello",
    autoPaste: true
  });

  assert.equal(createdTopics.includes("device:user-1:desktop-1"), true);
  assert.equal(createdTopics.includes("device:user-1:phone-1"), true);
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
});
