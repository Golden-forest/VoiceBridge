import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function defaultAuthStoragePath() {
  return path.join(os.homedir(), ".voicebridge", "auth-storage.json");
}

export function createFileAuthStorage(filePath = defaultAuthStoragePath()) {
  return {
    async getItem(key) {
      const values = await readValues(filePath);
      return typeof values[key] === "string" ? values[key] : null;
    },
    async setItem(key, value) {
      const values = await readValues(filePath);
      values[key] = String(value);
      await writeValues(filePath, values);
    },
    async removeItem(key) {
      const values = await readValues(filePath);
      delete values[key];
      await writeValues(filePath, values);
    }
  };
}

async function readValues(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeValues(filePath, values) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(values)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}
