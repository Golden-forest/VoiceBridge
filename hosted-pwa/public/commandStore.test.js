import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { commandStore } from "./commandStore.js";

const migration = await readFile(
  new URL("../../supabase/migrations/0008_command_presets.sql", import.meta.url),
  "utf8"
);

test("command preset migration seeds all shared prefixes with exactly ten free presets", () => {
  const match = migration.match(/\$presets\$(\[.*\])\$presets\$/s);
  assert.ok(match);
  const presets = JSON.parse(match[1]);

  assert.equal(presets.length, 99);
  assert.equal(presets.filter((preset) => preset.required_plan === "free").length, 10);
  assert.equal(presets.some((preset) => preset.category.startsWith("Personal/")), false);
});

test("commandStore merges private commands and presets with free-plan locks", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    VoiceBridgeAuth: {
      user: { id: "user-1" },
      supabase: createSupabase({
        user_commands: [{
          id: "user-command",
          label: "Mine",
          text: "private",
          category: "User",
          command_presets: null
        }],
        command_presets: [
          { id: "free-preset", label: "Free", text: "free", category: "Preset", required_plan: "free" },
          { id: "pro-preset", label: "Pro", text: "pro", category: "Preset", required_plan: "pro" }
        ],
        subscriptions: null
      })
    }
  };

  try {
    const commands = await commandStore.list();
    assert.deepEqual(commands.map(({ id, source, locked }) => ({ id, source, locked })), [
      { id: "user-command", source: "user", locked: false },
      { id: "free-preset", source: "preset", locked: false },
      { id: "pro-preset", source: "preset", locked: true }
    ]);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("commandStore unlocks Pro presets only for an active Pro subscription", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    VoiceBridgeAuth: {
      user: { id: "user-1" },
      supabase: createSupabase({
        user_commands: [],
        command_presets: [
          { id: "pro-preset", label: "Pro", text: "pro", category: "Preset", required_plan: "pro" }
        ],
        subscriptions: { plan: "pro", status: "active" }
      })
    }
  };

  try {
    const [preset] = await commandStore.list();
    assert.equal(preset.locked, false);
  } finally {
    globalThis.window = originalWindow;
  }
});

function createSupabase(dataByTable) {
  return {
    from(table) {
      const result = { data: dataByTable[table], error: null };
      const query = {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle() { return Promise.resolve(result); },
        then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); }
      };
      return query;
    }
  };
}
