import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { loadOrCreateDevice } from "./deviceStore.js";
import { handleDesktopMessage, startRealtimeAgent } from "./realtimeAgent.js";

test("handleDesktopMessage ignores messages for another device", async () => {
  let called = false;
  const result = await handleDesktopMessage({
    payload: {
      type: "insert_text",
      request_id: "request-1",
      source_device_id: "phone-1",
      target_device_id: "desktop-other",
      text: "hello"
    },
    myDeviceId: "desktop-1",
    output: async () => { called = true; }
  });

  assert.equal(result.handled, false);
  assert.equal(called, false);
});

test("handleDesktopMessage outputs text and returns ack", async () => {
  const calls = [];
  const result = await handleDesktopMessage({
    payload: {
      type: "insert_text",
      request_id: "request-1",
      source_device_id: "phone-1",
      target_device_id: "desktop-1",
      text: "hello",
      auto_paste: true
    },
    myDeviceId: "desktop-1",
    output: async (text, options) => {
      calls.push({ text, options });
      return { copied: true, pasted: true, pasteError: null };
    }
  });

  assert.equal(result.handled, true);
  assert.equal(calls[0].text, "hello");
  assert.equal(calls[0].options.autoPaste, true);
  assert.equal(result.ack.status, "success");
  assert.equal(result.ack.target_device_id, "phone-1");
});

test("handleDesktopMessage reports auto paste failures in ack detail", async () => {
  const result = await handleDesktopMessage({
    payload: {
      type: "insert_text",
      request_id: "request-1",
      source_device_id: "phone-1",
      target_device_id: "desktop-1",
      text: "hello",
      auto_paste: true
    },
    myDeviceId: "desktop-1",
    output: async () => ({ copied: true, pasted: false, pasteError: "paste denied" })
  });

  assert.equal(result.handled, true);
  assert.equal(result.ack.status, "failed");
  assert.equal(result.ack.detail, "paste denied");
});

test("handleDesktopMessage executes key commands before returning success ack", async () => {
  const calls = [];
  const result = await handleDesktopMessage({
    payload: {
      type: "key",
      request_id: "request-key-1",
      source_device_id: "phone-1",
      target_device_id: "desktop-1",
      key: "enter"
    },
    myDeviceId: "desktop-1",
    keyHandlers: {
      enter: async () => calls.push("enter")
    }
  });

  assert.deepEqual(calls, ["enter"]);
  assert.equal(result.handled, true);
  assert.equal(result.ack.status, "success");
  assert.equal(result.ack.key, "enter");
  assert.equal(result.ack.detail, "key:enter");
});

test("handleDesktopMessage activates a selected cloud window before text output", async () => {
  const calls = [];
  await handleDesktopMessage({
    payload: {
      type: "insert_text",
      request_id: "request-window-1",
      source_device_id: "phone-1",
      target_device_id: "desktop-1",
      target_window_id: "opaque-window",
      text: "hello"
    },
    myDeviceId: "desktop-1",
    activateWindow: async (windowId) => calls.push(`activate:${windowId}`),
    output: async () => {
      calls.push("output");
      return { copied: true, pasted: true, pasteError: null };
    }
  });

  assert.deepEqual(calls, ["activate:opaque-window", "output"]);
});

test("handleDesktopMessage does not type when the selected window cannot be activated", async () => {
  let outputCalled = false;
  const result = await handleDesktopMessage({
    payload: {
      type: "insert_text",
      request_id: "request-window-2",
      source_device_id: "phone-1",
      target_device_id: "desktop-1",
      target_window_id: "stale-window",
      text: "hello"
    },
    myDeviceId: "desktop-1",
    activateWindow: async () => ({ success: false, error: "window closed" }),
    output: async () => {
      outputCalled = true;
      return { copied: true, pasted: true, pasteError: null };
    }
  });

  assert.equal(outputCalled, false);
  assert.equal(result.ack.status, "failed");
  assert.equal(result.ack.detail, "window closed");
});

test("startRealtimeAgent backs off across flaps instead of resetting to 1s on transient health", async () => {
  const statuses = [];
  let messageSubscribers = [];
  let presenceSubscribers = [];
  const channelStore = new Map();
  const supabase = {
    channel(topic) {
      if (!channelStore.has(topic)) {
        channelStore.set(topic, {
          topic,
          removed: false,
          on() { return this; },
          async subscribe(callback) {
            if (topic.endsWith("desktop-1")) messageSubscribers.push(callback);
            if (topic.endsWith("presence")) presenceSubscribers.push(callback);
            await callback?.("SUBSCRIBED");
            return "ok";
          },
          async track() { return "ok"; },
          async send() { return "ok"; },
          async unsubscribe() { return "ok"; }
        });
      }
      return channelStore.get(topic);
    },
    async removeChannel(channel) {
      channel.removed = true;
      channelStore.delete(channel.topic);
    }
  };

  const agent = await startRealtimeAgent({
    supabase,
    userId: "user-1",
    device: { id: "desktop-1", name: "Desk", platform: "darwin" },
    listWindows: async () => [],
    onStatus: (status) => statuses.push(status)
  });

  try {
    // 第一次断开：退避 1s
    messageSubscribers.at(-1)("CLOSED");
    assert.ok(statuses.some((s) => s === "reconnect:scheduled:message:CLOSED:1000ms"));

    // 等 1s 退避结束、重建成功（瞬时 SUBSCRIBED 不应清零重连计数）
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(agent.getHealth().online, true);

    // 第二次断开：退避必须增长到 2s，而不是又回到 1s
    messageSubscribers = messageSubscribers.filter((cb) => !channelStore.get("device:user-1:desktop-1")?.removed);
    const latestMessageCb = messageSubscribers.at(-1);
    latestMessageCb("CLOSED");
    assert.ok(
      statuses.some((s) => s === "reconnect:scheduled:message:CLOSED:2000ms"),
      `expected 2000ms backoff, got: ${statuses.filter((s) => s.startsWith("reconnect:scheduled")).join(", ")}`
    );
  } finally {
    await agent.stop();
  }
});

test("startRealtimeAgent reuses ack channels and cleans them up", async () => {
  const channels = new Map();
  const createdTopics = [];
  const unsubscribedTopics = [];
  const subscribedTopics = [];
  const statuses = [];
  let commandHandler;

  const supabase = {
    channel(topic) {
      createdTopics.push(topic);
      if (!channels.has(topic)) {
        channels.set(topic, {
          topic,
          sends: [],
          on(eventType, filter, handler) {
            if (eventType === "broadcast" && filter.event === "command") {
              commandHandler = handler;
            }
            return this;
          },
          async subscribe(callback) {
            subscribedTopics.push(topic);
            await callback?.("SUBSCRIBED");
            return "ok";
          },
          async track() {
            return "ok";
          },
          async send(message) {
            this.sends.push(message);
            return this.sends.length === 1 ? "error" : "ok";
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

  const agent = await startRealtimeAgent({
    supabase,
    userId: "user-1",
    device: { id: "desktop-1", name: "Desk", platform: "darwin" },
    listWindows: async () => [],
    output: async () => ({ copied: true, pasted: true, pasteError: null }),
    onStatus: (status) => statuses.push(status)
  });

  const payload = {
    type: "insert_text",
    request_id: "request-1",
    source_device_id: "phone-1",
    target_device_id: "desktop-1",
    text: "hello"
  };
  await commandHandler({ payload });
  await commandHandler({ payload: { ...payload, request_id: "request-2" } });

  assert.equal(createdTopics.filter((topic) => topic === "device:user-1:phone-1").length, 1);
  assert.equal(subscribedTopics.filter((topic) => topic === "device:user-1:phone-1").length, 1);
  assert.equal(channels.get("device:user-1:phone-1").sends.length, 2);
  assert.ok(statuses.includes("ack:phone-1:error"));

  await agent.stop();

  assert.deepEqual(unsubscribedTopics.sort(), [
    "device:user-1:desktop-1",
    "device:user-1:phone-1",
    "user:user-1:presence"
  ].sort());
});

test("startRealtimeAgent warms ack channel by deviceId, not presence key", async () => {
  const channels = new Map();
  const createdTopics = [];
  let joinHandler;

  const supabase = {
    channel(topic) {
      createdTopics.push(topic);
      if (!channels.has(topic)) {
        channels.set(topic, {
          topic,
          on(eventType, filter, handler) {
            if (eventType === "presence" && filter.event === "join") {
              joinHandler = handler;
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
        });
      }
      return channels.get(topic);
    }
  };

  const agent = await startRealtimeAgent({
    supabase,
    userId: "user-1",
    device: { id: "desktop-1", name: "Desk", platform: "darwin" },
    listWindows: async () => [],
    output: async () => ({ copied: true, pasted: true, pasteError: null })
  });

  // 手机重连后 presence key 每次都是新的随机值，但 payload 里的 deviceId 稳定。
  joinHandler({ key: "random-key-1", newPresences: [{ deviceId: "phone-1" }] });
  await new Promise((resolve) => setImmediate(resolve));
  joinHandler({ key: "random-key-2", newPresences: [{ deviceId: "phone-1" }] });
  await new Promise((resolve) => setImmediate(resolve));

  try {
    const phoneTopics = createdTopics.filter((topic) => topic === "device:user-1:phone-1");
    assert.equal(phoneTopics.length, 1, `expected one warmup channel, got ${createdTopics.join(", ")}`);
  } finally {
    await agent.stop();
  }
});

test("startRealtimeAgent never overlaps window presence scans", async () => {
  let activeScans = 0;
  let maxActiveScans = 0;
  let scanCount = 0;
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
        async track() {
          return "ok";
        },
        async unsubscribe() {
          return "ok";
        }
      };
    }
  };

  const agent = await startRealtimeAgent({
    supabase,
    userId: "user-1",
    device: { id: "desktop-1", name: "Desk", platform: "darwin" },
    windowRefreshMs: 1,
    listWindows: async () => {
      scanCount++;
      activeScans++;
      maxActiveScans = Math.max(maxActiveScans, activeScans);
      await new Promise((resolve) => setTimeout(resolve, 8));
      activeScans--;
      return [];
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  await agent.stop();

  assert.ok(scanCount >= 2);
  assert.equal(maxActiveScans, 1);
});

test("loadOrCreateDevice rejects malformed device JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-device-"));
  const filePath = path.join(dir, "device.json");
  await fs.writeFile(filePath, "{bad json", "utf8");

  await assert.rejects(
    loadOrCreateDevice(filePath),
    SyntaxError
  );
});

test("startRealtimeAgent includes lanEndpoints in presence and updates them via setLanEndpoints", async () => {
  const trackedPayloads = [];
  const makeChannel = (topic) => ({
    topic,
    on() { return this; },
    async subscribe(callback) {
      await callback?.("SUBSCRIBED");
      return "ok";
    },
    async track(payload) {
      trackedPayloads.push(payload);
      return "ok";
    },
    async send() { return "ok"; },
    async unsubscribe() { return "ok"; }
  });
  const supabase = {
    channel: (topic) => makeChannel(topic)
  };

  const endpoints = [{ host: "192.168.1.42", port: 3000, httpPort: 3001 }];
  const agent = await startRealtimeAgent({
    supabase,
    userId: "user-1",
    device: { id: "desktop-1", name: "Desk", platform: "darwin" },
    listWindows: async () => [],
    lanEndpoints: endpoints
  });

  assert.deepEqual(trackedPayloads[trackedPayloads.length - 1].lanEndpoints, endpoints);

  await agent.setLanEndpoints([{ host: "10.0.0.5", port: 4000, httpPort: 4001 }]);
  assert.deepEqual(
    trackedPayloads[trackedPayloads.length - 1].lanEndpoints,
    [{ host: "10.0.0.5", port: 4000, httpPort: 4001 }]
  );

  await agent.setLanEndpoints([]);
  assert.equal(
    trackedPayloads[trackedPayloads.length - 1].lanEndpoints,
    undefined,
    "empty lanEndpoints should be omitted from presence"
  );

  await agent.setLanEndpoints([{ host: "", port: 1, httpPort: 2 }, { host: "bad" }]);
  assert.equal(trackedPayloads[trackedPayloads.length - 1].lanEndpoints, undefined);

  await agent.stop();
});

test("startRealtimeAgent rebuilds channels when CLOSED arrives and recovers health", async () => {
  const createdTopics = [];
  const statuses = [];
  let closedOnce = false;
  let messageSubscribers = [];
  let presenceSubscribers = [];
  const channelStore = new Map();

  const makeChannel = (topic) => ({
    topic,
    removed: false,
    on() { return this; },
    async subscribe(callback) {
      if (topic.endsWith("desktop-1")) messageSubscribers.push(callback);
      if (topic.endsWith("presence")) presenceSubscribers.push(callback);
      await callback?.("SUBSCRIBED");
      return "ok";
    },
    async track() { return "ok"; },
    async send() { return "ok"; },
    async unsubscribe() { return "ok"; }
  });

  const supabase = {
    channel(topic) {
      createdTopics.push(topic);
      if (!channelStore.has(topic) || channelStore.get(topic).removed) {
        channelStore.set(topic, makeChannel(topic));
      }
      return channelStore.get(topic);
    },
    async removeChannel(channel) {
      channel.removed = true;
      channelStore.delete(channel.topic);
    }
  };

  const agent = await startRealtimeAgent({
    supabase,
    userId: "user-1",
    device: { id: "desktop-1", name: "Desk", platform: "darwin" },
    listWindows: async () => [],
    output: async () => ({ copied: true, pasted: true, pasteError: null }),
    onStatus: (status) => statuses.push(status)
  });

  assert.equal(agent.getHealth().online, true);

  // 模拟服务端 close 主通道：旧实现里这会永久死亡。
  const originalMessageSubscribers = [...messageSubscribers];
  originalMessageSubscribers.at(-1)("CLOSED");
  assert.equal(agent.getHealth().online, false);
  assert.ok(statuses.some((s) => s.startsWith("reconnect:scheduled")));

  // 退避 1s 后重建——测试里直接等待重建完成。
  await new Promise((resolve) => setTimeout(resolve, 1300));

  assert.equal(agent.getHealth().online, true, "watchdog should have rebuilt and recovered");
  assert.ok(statuses.includes("reconnect:recovered"));
  assert.ok(
    createdTopics.filter((topic) => topic === "device:user-1:desktop-1").length >= 2,
    "message channel must be recreated after close"
  );
  closedOnce = true;
  assert.ok(closedOnce);

  await agent.stop();
  assert.equal(agent.getHealth().online, false);
});
