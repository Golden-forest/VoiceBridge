import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_PATH = join(__dirname, "../../public/commands.json");

async function readCommandsFile() {
  try {
    const raw = await readFile(COMMANDS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCommandsFile(data) {
  await writeFile(COMMANDS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function migrateOldFormat(data) {
  if (data && data.commands && Array.isArray(data.commands)) {
    return data;
  }

  const now = Date.now();
  const commands = [];

  if (data) {
    if (Array.isArray(data.shortcuts)) {
      for (const cmd of data.shortcuts) {
        commands.push({
          id: randomUUID(),
          text: cmd.text,
          label: cmd.label,
          category: "斜杠指令",
          createdAt: now,
          lastUsedAt: null,
        });
      }
    }
    if (Array.isArray(data.terminal)) {
      for (const cmd of data.terminal) {
        commands.push({
          id: randomUUID(),
          text: cmd.text,
          label: cmd.label,
          category: "终端",
          createdAt: now,
          lastUsedAt: null,
        });
      }
    }
    if (Array.isArray(data.quick)) {
      for (const cmd of data.quick) {
        let category = "通用";
        const t = cmd.text;
        if (t.startsWith("/")) category = "斜杠指令";
        else if (/npm|node|copyclaw|server|cli/.test(t)) category = "终端";
        else if (/审查|巡检|实测|分析|复查|修复|bug/.test(t)) category = "工作流";
        else if (/确认|计划|目标|最优|关联|问清|代码|需求/.test(t)) category = "开发协作";
        commands.push({
          id: randomUUID(),
          text: cmd.text,
          label: cmd.label,
          category,
          createdAt: now,
          lastUsedAt: null,
        });
      }
    }
  }

  if (commands.length === 0) {
    return { commands: [] };
  }

  return { commands };
}

export async function ensureCommandsFile() {
  const data = await readCommandsFile();
  const migrated = migrateOldFormat(data);
  await writeCommandsFile(migrated);
  return migrated;
}

export function createCommandsRouter() {
  const router = express.Router();

  router.get("/commands", async (_req, res) => {
    try {
      const data = await ensureCommandsFile();
      res.json(data.commands);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/commands", async (req, res) => {
    try {
      const { text, label, category } = req.body;
      if (!text || !label || !category) {
        res.status(400).json({ error: "缺少 text, label 或 category 字段" });
        return;
      }
      const now = Date.now();
      const cmd = {
        id: randomUUID(),
        text,
        label,
        category,
        createdAt: now,
        lastUsedAt: null,
      };
      const data = await ensureCommandsFile();
      data.commands.push(cmd);
      await writeCommandsFile(data);
      res.status(201).json(cmd);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/commands/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const data = await ensureCommandsFile();
      const idx = data.commands.findIndex((c) => c.id === id);
      if (idx === -1) {
        res.status(404).json({ error: "指令不存在" });
        return;
      }
      data.commands[idx] = { ...data.commands[idx], ...updates, id };
      await writeCommandsFile(data);
      res.json(data.commands[idx]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/commands/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const data = await ensureCommandsFile();
      const idx = data.commands.findIndex((c) => c.id === id);
      if (idx === -1) {
        res.status(404).json({ error: "指令不存在" });
        return;
      }
      data.commands.splice(idx, 1);
      await writeCommandsFile(data);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
