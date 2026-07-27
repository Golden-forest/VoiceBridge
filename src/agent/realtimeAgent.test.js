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

test("startRealtimeAgent reuses ack channels and cleans them up", async () => {
  const channels = new Map();
  const createdTopics = [];
  const unsubscribedTopics = [];
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
  assert.equal(channels.get("device:user-1:phone-1").sends.length, 2);
  assert.ok(statuses.includes("ack:phone-1:error"));

  await agent.stop();

  assert.deepEqual(unsubscribedTopics.sort(), [
    "device:user-1:desktop-1",
    "device:user-1:phone-1",
    "user:user-1:presence"
  ].sort());
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
