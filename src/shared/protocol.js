export const MESSAGE_TYPES = Object.freeze({
  INSERT_TEXT: "insert_text",
  ACK: "ack",
  KEY: "key"
});

export function presenceChannel(userId) {
  return `user:${userId}:presence`;
}

export function deviceChannel(userId, deviceId) {
  return `device:${userId}:${deviceId}`;
}

export function createRequestId() {
  return crypto.randomUUID();
}

export function isInsertTextMessage(payload, myDeviceId) {
  return Boolean(
    payload &&
    payload.type === MESSAGE_TYPES.INSERT_TEXT &&
    typeof payload.request_id === "string" &&
    typeof payload.source_device_id === "string" &&
    payload.target_device_id === myDeviceId &&
    typeof payload.text === "string" &&
    payload.text.length > 0 &&
    payload.text.length <= 10000
  );
}

export function isAckMessage(payload, myDeviceId) {
  return Boolean(
    payload &&
    payload.type === MESSAGE_TYPES.ACK &&
    typeof payload.request_id === "string" &&
    typeof payload.source_device_id === "string" &&
    payload.target_device_id === myDeviceId &&
    ["success", "failed"].includes(payload.status)
  );
}
