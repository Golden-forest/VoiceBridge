// Cloud command store backed by Supabase (user_commands table, RLS-isolated).
// Mirrors the response shape of the LAN route (src/server/routes/commands.js)
// so callers (app.js) work unchanged.
//
// Auth: reuses the global Supabase client exposed at window.VoiceBridgeAuth.supabase
// (same pattern as cloudTranscribe.js / cloudRealtime.js).
// RLS guarantees user_id = auth.uid() — no user identity is hardcoded here.

const SEED_URL = "/commands.json";

// Fields the client is allowed to send to update();
// matches ALLOWED_UPDATE_FIELDS in the previous Edge Function version.
const ALLOWED_UPDATE_FIELDS = ["text", "label", "category", "lastUsedAt"];

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.status = 404;
  }
}

function getSupabaseClient() {
  const supabase = globalThis.window?.VoiceBridgeAuth?.supabase;
  if (!supabase) {
    throw new Error("请先登录后再使用指令库。");
  }
  return supabase;
}

// snake_case DB row -> camelCase client command
function fromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    label: row.label,
    category: row.category,
    sortOrder: row.sort_order ?? 0,
    isFavorite: row.is_favorite ?? false,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).getTime() : null
  };
}

function wrapError(error, fallbackMessage) {
  const message = error?.message || fallbackMessage;
  if (error?.code === "PGRST116" || error?.code === "42P01") {
    return new NotFoundError(message);
  }
  const err = new Error(message);
  err.status = error?.status || 500;
  return err;
}

export const commandStore = {
  // GET user_commands ordered by sort_order -> Command[]
  async list() {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("user_commands")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw wrapError(error, "获取指令列表失败。");
    return (data || []).map(fromDb);
  },

  // POST insert -> created Command
  async create({ text, label, category }) {
    if (!text || !label || !category) {
      throw new Error("缺少 text, label 或 category 字段");
    }
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("user_commands")
      .insert({
        text,
        label,
        category
      })
      .select("*")
      .single();
    if (error) throw wrapError(error, "保存指令失败。");
    return fromDb(data);
  },

  // PATCH update -> updated Command
  async update(id, updates) {
    if (!id) {
      throw new Error("缺少指令 id");
    }
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

    // camelCase -> snake_case
    const dbUpdates = {};
    if ("text" in filtered) dbUpdates.text = filtered.text;
    if ("label" in filtered) dbUpdates.label = filtered.label;
    if ("category" in filtered) dbUpdates.category = filtered.category;
    if ("lastUsedAt" in filtered) {
      dbUpdates.last_used_at = filtered.lastUsedAt
        ? new Date(filtered.lastUsedAt).toISOString()
        : null;
    }

    if (Object.keys(dbUpdates).length === 0) {
      throw new Error("没有可更新的字段。");
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("user_commands")
      .update(dbUpdates)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw wrapError(error, "更新指令失败。");
    if (!data) throw new NotFoundError("指令不存在。");
    return fromDb(data);
  },

  // DELETE -> { ok: true }
  async remove(id) {
    if (!id) {
      throw new Error("缺少指令 id");
    }
    const supabase = getSupabaseClient();
    const { error, count } = await supabase
      .from("user_commands")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) throw wrapError(error, "删除指令失败。");
    if (!count || count === 0) throw new NotFoundError("指令不存在。");
    return { ok: true };
  },

  // Fetch /commands.json (public seed, 142 entries after Personal removal)
  // and batch-insert under the current user (RLS sets user_id via JWT).
  // Returns { imported: number }.
  async importSeedCommands() {
    const supabase = getSupabaseClient();
    const res = await fetch(SEED_URL);
    if (!res.ok) {
      throw new Error(`拉取种子指令失败 (${res.status})。`);
    }
    const json = await res.json();
    const seed = Array.isArray(json) ? json : json.commands || [];
    if (!seed.length) return { imported: 0 };

    const BATCH = 50;
    let inserted = 0;
    for (let i = 0; i < seed.length; i += BATCH) {
      const batch = seed.slice(i, i + BATCH).map((c, idx) => ({
        text: c.text,
        label: c.label,
        category: c.category || "uncategorized",
        sort_order: i + idx
      }));
      const { data, error } = await supabase
        .from("user_commands")
        .insert(batch)
        .select("id");
      if (error) throw wrapError(error, "导入种子指令失败。");
      inserted += data?.length || 0;
    }
    return { imported: inserted };
  }
};

export { NotFoundError };
