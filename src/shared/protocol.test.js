import test from "node:test";
import assert from "node:assert/strict";
import {
  deviceChannel,
  presenceChannel,
  isInsertTextMessage,
  isAckMessage,
  isKeyMessage,
  buildKeyMessage,
  isProtocolCompatible
} from "./protocol.js";

test("channel helpers create stable private channel names", () => {
  assert.equal(presenceChannel("user-1"), "user:user-1:presence");
  assert.equal(deviceChannel("user-1", "device-1"), "device:user-1:device-1");
});

test("protocol version rejects outdated desktop clients", () => {
  assert.equal(isProtocolCompatible(2), true);
  assert.equal(isProtocolCompatible(1), false);
  assert.equal(isProtocolCompatible(undefined), false);
});

test("isInsertTextMessage validates message shape and target", () => {
  assert.equal(isInsertTextMessage({
    type: "insert_text",
    request_id: "request-1",
    source_device_id: "phone-1",
    target_device_id: "desktop-1",
    text: "hello",
    auto_paste: true
  }, "desktop-1"), true);
  assert.equal(isInsertTextMessage({
    type: "insert_text",
    request_id: "request-1",
    source_device_id: "phone-1",
    target_device_id: "other-desktop",
    text: "hello"
  }, "desktop-1"), false);
});

test("isAckMessage validates ack for source device", () => {
  assert.equal(isAckMessage({
    type: "ack",
    request_id: "request-1",
    source_device_id: "desktop-1",
    target_device_id: "phone-1",
    status: "success",
    detail: "pasted"
  }, "phone-1"), true);
});

test("key messages share one validated shape across cloud and LAN", () => {
  const message = buildKeyMessage({
    sourceDeviceId: "phone-1",
    targetDeviceId: "desktop-1",
    key: "enter"
  });

  assert.equal(isKeyMessage(message, "desktop-1"), true);
  assert.equal(isKeyMessage({ ...message, key: "launch-calculator" }, "desktop-1"), false);
  assert.equal(isKeyMessage({ ...message, target_window_id: "window-1" }, "desktop-1"), true);
  assert.equal(isKeyMessage({ ...message, target_window_id: "" }, "desktop-1"), false);
});
