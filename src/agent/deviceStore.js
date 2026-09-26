import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

export function defaultDevicePath() {
  return path.join(os.homedir(), ".voicebridge", "device.json");
}

export async function loadOrCreateDevice(filePath = defaultDevicePath()) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }

    return createDevice(filePath);
  }

  return JSON.parse(raw);
}

export async function rotateDeviceIdentity(filePath = defaultDevicePath()) {
  const current = await loadOrCreateDevice(filePath);
  return writeDevice(filePath, {
    ...current,
    id: crypto.randomUUID()
  });
}

async function createDevice(filePath) {
  const device = {
    id: crypto.randomUUID(),
    name: os.hostname(),
    platform: process.platform
  };
  return writeDevice(filePath, device);
}

async function writeDevice(filePath, device) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(device, null, 2) + "\n", "utf8");
  await fs.rename(tmpPath, filePath);
  return device;
}
