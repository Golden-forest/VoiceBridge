// Local command store backed by localStorage.
// Mirrors the semantics of the LAN Express endpoint (src/server/routes/commands.js)
// so the PWA can run on Cloudflare Pages without /api/commands.

const STORAGE_KEY = "voicebridge_commands";
const SEED_URL = "/commands.json";

// Field validation constants must stay in sync with the LAN route.
const ALLOWED_UPDATE_FIELDS = ["text", "label", "category", "lastUsedAt"];
const MAX_TEXT_LEN = 2000;
const MAX_LABEL_LEN = 100;
const MAX_CATEGORY_LEN = 50;

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.status = 404;
  }
}

function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC4122 v4 fallback for older browsers.
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(
    /[018]/g,
    (c) => {
      const rnd = (crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) & 15;
      const v = c ^ (rnd >> (c / 4));
      return v.toString(16);
    }
  );
}

function isString(v) {
  return typeof v === "string";
}

function validateCommandFields({ text, label, category }) {
  if (!text || !label || !category) {
    throw new Error("缺少 text, label 或 category 字段");
  }
  if (
    !isString(text) ||
    !isString(label) ||
    !isString(category) ||
    text.length > MAX_TEXT_LEN ||
    label.length > MAX_LABEL_LEN ||
    category.length > MAX_CATEGORY_LEN
  ) {
    throw new Error("字段值无效");
  }
}

async function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.commands)) return parsed.commands;
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch (err) {
    console.warn("commandStore.readAll: failed to parse storage:", err);
    return null;
  }
}

async function writeAll(commands) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ commands }));
}

async function ensureSeeded() {
  const existing = await readAll();
  if (existing) return existing;
  try {
    const res = await fetch(SEED_URL);
    if (!res.ok) {
      console.warn("commandStore: seed fetch failed:", res.status);
      await writeAll([]);
      return [];
    }
    const data = await res.json();
    const commands = Array.isArray(data?.commands)
      ? data.commands
      : Array.isArray(data)
        ? data
        : [];
    await writeAll(commands);
    return commands;
  } catch (err) {
    console.warn("commandStore: seed fetch threw:", err);
    await writeAll([]);
    return [];
  }
}

export const commandStore = {
  // GET /api/commands -> array
  async list() {
    return await ensureSeeded();
  },

  // POST /api/commands -> created command object
  async create({ text, label, category }) {
    validateCommandFields({ text, label, category });
    const now = Date.now();
    const cmd = {
      id: uuid(),
      text,
      label,
      category,
      createdAt: now,
      lastUsedAt: null,
    };
    const commands = await ensureSeeded();
    commands.push(cmd);
    await writeAll(commands);
    return cmd;
  },

  // PUT /api/commands/:id -> updated command object
  async update(id, updates) {
    const filtered = {};
    if (updates && typeof updates === "object") {
      for (const key of ALLOWED_UPDATE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
          filtered[key] = updates[key];
        }
      }
    }
    if (filtered.lastUsedAt != null) {
      filtered.lastUsedAt = Number(filtered.lastUsedAt) || Date.now();
    }
    const commands = await ensureSeeded();
    const idx = commands.findIndex((c) => c.id === id);
    if (idx === -1) {
      throw new NotFoundError("指令不存在");
    }
    commands[idx] = { ...commands[idx], ...filtered, id };
    await writeAll(commands);
    return commands[idx];
  },

  // DELETE /api/commands/:id -> { ok: true }
  async remove(id) {
    const commands = await ensureSeeded();
    const idx = commands.findIndex((c) => c.id === id);
    if (idx === -1) {
      throw new NotFoundError("指令不存在");
    }
    commands.splice(idx, 1);
    await writeAll(commands);
    return { ok: true };
  },
};

export { NotFoundError };
