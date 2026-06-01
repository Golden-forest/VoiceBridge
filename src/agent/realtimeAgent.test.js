import test from "node:test";
import assert from "node:assert/strict";
import { handleDesktopMessage } from "./realtimeAgent.js";

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
