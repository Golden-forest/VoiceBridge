import test from "node:test";
import assert from "node:assert/strict";
import {
  deviceChannel,
  presenceChannel,
  isInsertTextMessage,
  isAckMessage
} from "./protocol.js";

test("channel helpers create stable private channel names", () => {
  assert.equal(presenceChannel("user-1"), "user:user-1:presence");
  assert.equal(deviceChannel("user-1", "device-1"), "device:user-1:device-1");
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
