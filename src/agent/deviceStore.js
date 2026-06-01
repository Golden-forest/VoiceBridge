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

async function createDevice(filePath) {
  const device = {
    id: crypto.randomUUID(),
    name: os.hostname(),
    platform: process.platform
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(device, null, 2) + "\n", "utf8");
  return device;
}
