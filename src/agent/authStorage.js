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
  // 原子写：先写临时文件再 rename，避免并发写（token 刷新 + session 保存）
  // 把文件截断成非法 JSON，导致匿名身份丢失、配对孤儿化。
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(values)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.rename(tmpPath, filePath);
}
