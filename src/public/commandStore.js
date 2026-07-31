// Cloud command store backed by RLS-protected user commands and read-only presets.
// Mirrors the response shape of the LAN route (src/server/routes/commands.js)
// so callers (app.js) work unchanged.
//
// Auth: reuses the global Supabase client exposed at window.VoiceBridgeAuth.supabase
// (same pattern as cloudTranscribe.js / cloudRealtime.js).
// RLS guarantees user_id = auth.uid() — no user identity is hardcoded here.

import { t } from "./i18n/i18n.js";

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
    throw new Error(t('commandStore.loginRequired'));
  }
  return supabase;
}

// snake_case DB row -> camelCase client command
function fromDb(row, { source, plan }) {
  if (!row) return null;
  const requiredPlan = source === "preset"
    ? row.required_plan || "free"
    : row.command_presets?.required_plan || "free";
  return {
    id: row.id,
    text: row.text,
    label: row.label,
    category: row.category,
    sortOrder: row.sort_order ?? 0,
    isFavorite: row.is_favorite ?? false,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).getTime() : null,
    source,
    requiredPlan,
    presetId: row.preset_id || null,
    locked: requiredPlan === "pro" && plan !== "pro"
  };
}

function resolvePlan(subscription) {
  if (!subscription) return "free";
  // Admin 视为已解锁全部指令（与 app.js planBadge 逻辑保持一致）
  if (subscription.plan === "admin" && ["active", "trialing"].includes(subscription.status)) {
    return "admin";
  }
  return subscription.plan === "pro"
    && ["active", "trialing"].includes(subscription.status)
    ? "pro"
    : "free";
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
  // Read private commands, global presets, and the current plan concurrently.
  async list() {
    const supabase = getSupabaseClient();
    const userId = globalThis.window?.VoiceBridgeAuth?.user?.id;
    const [usersResult, presetsResult, subscriptionResult] = await Promise.all([
      supabase
        .from("user_commands")
        .select("*, command_presets(required_plan)")
        .eq("user_id", userId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("command_presets")
        .select("*")
        .order("sort_order", { ascending: true }),
      supabase
        .from("subscriptions")
        .select("plan,status,updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);
    if (usersResult.error) throw wrapError(usersResult.error, t('commandStore.fetchPersonalFailed'));
    if (presetsResult.error) throw wrapError(presetsResult.error, t('commandStore.fetchPresetFailed'));
    const plan = resolvePlan(subscriptionResult.data);
    return [
      ...(usersResult.data || []).map((row) => fromDb(row, { source: "user", plan })),
      ...(presetsResult.data || []).map((row) => fromDb(row, { source: "preset", plan }))
    ];
  },

  // POST insert -> created Command
  async create({ text, label, category }) {
    if (!text || !label || !category) {
      throw new Error(t('commandStore.missingFields'));
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
    if (error) throw wrapError(error, t('commandStore.saveFailed'));
    return fromDb(data, { source: "user", plan: "free" });
  },

  // PATCH update -> updated Command
  async update(id, updates) {
    if (!id) {
      throw new Error(t('commandStore.missingId'));
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
      throw new Error(t('commandStore.nothingToUpdate'));
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("user_commands")
      .update(dbUpdates)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw wrapError(error, t('commandStore.updateFailed'));
    if (!data) throw new NotFoundError(t('commandStore.notExist'));
    return fromDb(data, { source: "user", plan: "free" });
  },

  // DELETE -> { ok: true }
  async remove(id) {
    if (!id) {
      throw new Error(t('commandStore.missingId'));
    }
    const supabase = getSupabaseClient();
    const { error, count } = await supabase
      .from("user_commands")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) throw wrapError(error, t('commandStore.deleteFailed'));
    if (!count || count === 0) throw new NotFoundError(t('commandStore.notExist'));
    return { ok: true };
  }
};

export { NotFoundError };
