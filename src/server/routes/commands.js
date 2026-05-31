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
  } catch (err) {
    if (err.code === "ENOENT") return null;
    console.warn(`readCommandsFile: failed to read ${COMMANDS_PATH}: ${err.message}`);
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
  if (data !== migrated) {
    await writeCommandsFile(migrated);
  }
  return migrated;
}

export function createCommandsRouter() {
  const router = express.Router();

  router.get("/commands", async (_req, res) => {
    try {
      const data = await ensureCommandsFile();
      res.json(data.commands);
    } catch (err) {
      console.error("GET /commands error:", err);
      res.status(500).json({ ok: false, error: "获取指令列表失败" });
    }
  });

  router.post("/commands", async (req, res) => {
    try {
      const { text, label, category } = req.body;
      if (!text || !label || !category) {
        res.status(400).json({ error: "缺少 text, label 或 category 字段" });
        return;
      }
      if (typeof text !== "string" || typeof label !== "string" || typeof category !== "string"
          || text.length > 2000 || label.length > 100 || category.length > 50) {
        res.status(400).json({ error: "字段值无效" });
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
      console.error("POST /commands error:", err);
      res.status(500).json({ ok: false, error: "保存指令失败" });
    }
  });

  router.put("/commands/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const ALLOWED_FIELDS = new Set(["text", "label", "category", "lastUsedAt"]);
      const updates = Object.fromEntries(
        Object.entries(req.body).filter(([key]) => ALLOWED_FIELDS.has(key))
      );
      // Ensure lastUsedAt is a numeric timestamp for type consistency
      if (updates.lastUsedAt != null) {
        updates.lastUsedAt = Number(updates.lastUsedAt) || Date.now();
      }
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
      console.error("PUT /commands error:", err);
      res.status(500).json({ ok: false, error: "更新指令失败" });
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
      console.error("DELETE /commands error:", err);
      res.status(500).json({ ok: false, error: "删除指令失败" });
    }
  });

  return router;
}
