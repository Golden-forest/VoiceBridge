import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { loadOrCreateDevice, rotateDeviceIdentity } from "./deviceStore.js";
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

test("startRealtimeAgent lets phoenix heal CHANNEL_ERROR without rebuilding channels", async () => {
  // 2026-09-27 重构回归：socket 级异常（CHANNEL_ERROR/TIMED_OUT，如跨境路径
  // 静默黑洞导致的心跳超时）由 phoenix 自愈——不 purge 通道、不重建、不排
  // 定时器。旧实现每次都全量重建，purge 的 leave() 又触发 CLOSED 排下一轮，
  // 形成 70% 调度都是自我回声的风暴。
  const statuses = [];
  let messageCb = null;
  const createdTopics = [];
  const supabase = {
    channel(topic) {
      createdTopics.push(topic);
      return {
        topic,
        on() { return this; },
        async subscribe(callback) {
          if (topic.endsWith("desktop-1")) messageCb = callback;
          await callback?.("SUBSCRIBED");
          return "ok";
        },
        async track() { return "ok"; },
        async send() { return "ok"; },
        async unsubscribe() { return "ok"; }
      };
    },
    async removeChannel() { return "ok"; }
  };

  const agent = await startRealtimeAgent({
    supabase,
    userId: "user-1",
    device: { id: "desktop-1", name: "Desk", platform: "darwin" },
    listWindows: async () => [],
    onStatus: (status) => statuses.push(status)
  });

  try {
    assert.equal(agent.getHealth().online, true);

    // socket 级异常：只降级显示，通道对象不动。
    messageCb("CHANNEL_ERROR");
    assert.equal(agent.getHealth().online, false);
    assert.ok(statuses.includes("health:degraded"));

    // phoenix 自动 rejoin：同一个回调再报 SUBSCRIBED，健康恢复。
    messageCb("SUBSCRIBED");
    assert.equal(agent.getHealth().online, true);
    assert.ok(statuses.includes("health:online"));

    // 没有任何重建发生：每个核心通道只创建过一次。
    assert.equal(createdTopics.filter((topic) => topic === "device:user-1:desktop-1").length, 1);
    assert.equal(createdTopics.filter((topic) => topic === "user:user-1:presence").length, 1);
    assert.ok(!statuses.some((s) => s.startsWith("rebuild:")), `unexpected rebuilds: ${statuses.join(", ")}`);
  } finally {
    await agent.stop();
  }
});

test("startRealtimeAgent rebuilds only the server-closed channel and ignores purge echoes", async () => {
  // 服务端 phx_close（CLOSED）的通道 phoenix 永不 rejoin，必须重建；
  // 但 purge 旧通道时 leave() 触发的 CLOSED 是回声，不得引发连锁重建。
  const statuses = [];
  let messageSubscribers = [];
  let presenceSubscribers = [];
  const createdTopics = [];
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
    onStatus: (status) => statuses.push(status)
  });

  try {
    assert.equal(agent.getHealth().online, true);

    // 服务端关闭 message 通道。
    messageSubscribers.at(-1)("CLOSED");
    await waitForAgent(() => createdTopics.filter((topic) => topic === "device:user-1:desktop-1").length === 2);

    // 只有 message 通道被重建；presence 通道原封不动。
    assert.equal(createdTopics.filter((topic) => topic === "user:user-1:presence").length, 1);
    assert.equal(agent.getHealth().online, true);

    // 旧通道的 purge 回声（迟到的 CLOSED）不会再触发重建。
    const staleCallback = messageSubscribers[0];
    staleCallback("CLOSED");
    await new Promise((resolve) => setTimeout(resolve, REBUILD_ECHO_WAIT_MS));
    assert.equal(createdTopics.filter((topic) => topic === "device:user-1:desktop-1").length, 2);
  } finally {
    await agent.stop();
  }
});

test("startRealtimeAgent watchdog rebuilds everything when healing stalls", async () => {
  // 看门狗兜底：message 通道连续不健康超过阈值（phoenix 自愈应远早于此），
  // 全量重建一次。节奏慢到不可能自我维持。
  const statuses = [];
  let messageCb = null;
  const createdTopics = [];
  const channelStore = new Map();
  const makeChannel = (topic) => ({
    topic,
    removed: false,
    on() { return this; },
    async subscribe(callback) {
      // 看门狗场景：message 通道第一次订阅成功，重建后的订阅永远失败。
      if (topic.endsWith("desktop-1")) {
        messageCb = callback;
        if (createdTopics.filter((t) => t === topic).length === 1) {
          await callback?.("SUBSCRIBED");
        } else {
          await callback?.("CHANNEL_ERROR");
        }
      } else {
        await callback?.("SUBSCRIBED");
      }
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
    watchdogIntervalMs: 5,
    watchdogUnhealthyMs: 15,
    onStatus: (status) => statuses.push(status)
  });

  try {
    assert.equal(agent.getHealth().online, true);
    // 模拟 phoenix 自愈卡死：通道异常后再无 SUBSCRIBED。
    messageCb("CHANNEL_ERROR");
    await waitForAgent(() => statuses.some((s) => s.startsWith("rebuild:full:watchdog")));
    assert.equal(agent.getHealth().online, false);
    // 全量重建确实重建了核心通道。
    assert.ok(createdTopics.filter((topic) => topic === "device:user-1:desktop-1").length >= 2);
    assert.ok(createdTopics.filter((topic) => topic === "user:user-1:presence").length >= 2);
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

test("rotateDeviceIdentity preserves device metadata and replaces a conflicted id", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voicebridge-device-"));
  const filePath = path.join(dir, "device.json");
  const original = await loadOrCreateDevice(filePath);
  const rotated = await rotateDeviceIdentity(filePath);

  assert.notEqual(rotated.id, original.id);
  assert.equal(rotated.name, original.name);
  assert.equal(rotated.platform, original.platform);
  assert.deepEqual(await loadOrCreateDevice(filePath), rotated);
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
  let messageSubscribers = [];
  const channelStore = new Map();

  const makeChannel = (topic) => ({
    topic,
    removed: false,
    on() { return this; },
    async subscribe(callback) {
      if (topic.endsWith("desktop-1")) messageSubscribers.push(callback);
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

  // 服务端 close 主通道：CLOSED 状态 phoenix 永不 rejoin，必须重建。
  messageSubscribers.at(-1)("CLOSED");
  await waitForAgent(() => createdTopics.filter((topic) => topic === "device:user-1:desktop-1").length === 2);

  assert.equal(agent.getHealth().online, true, "rebuild should have recovered health");
  assert.ok(
    createdTopics.filter((topic) => topic === "device:user-1:desktop-1").length >= 2,
    "message channel must be recreated after close"
  );

  await agent.stop();
  assert.equal(agent.getHealth().online, false);
});

const REBUILD_ECHO_WAIT_MS = 60;

async function waitForAgent(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
