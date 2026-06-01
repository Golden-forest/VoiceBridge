import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

export function defaultDevicePath() {
  return path.join(os.homedir(), ".voicebridge", "device.json");
}

export async function loadOrCreateDevice(filePath = defaultDevicePath()) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    const device = {
      id: crypto.randomUUID(),
      name: os.hostname(),
      platform: process.platform
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(device, null, 2) + "\n", "utf8");
    return device;
  }
}
