import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const supabaseUrl = process.env.VOICEBRIDGE_DESKTOP_SUPABASE_URL
  || process.env.SUPABASE_URL
  || "https://gqxxknusznbunkiznnal.supabase.co";
const supabaseAnonKey = process.env.VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY
  || process.env.SUPABASE_ANON_KEY
  || "";
const webAppUrl = process.env.VOICEBRIDGE_WEB_APP_URL
  || "https://voicebridge-cloud.hl19970903.chatgpt.site";

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Missing VOICEBRIDGE_DESKTOP_SUPABASE_URL or VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY for Electron packaging."
  );
  console.error("These are public Supabase client values, not service secrets.");
  process.exit(1);
}

const outputPath = path.resolve("src/agent/electron/desktop-config.json");
const payload = {
  supabaseUrl,
  supabaseAnonKey,
  webAppUrl
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote Electron desktop public config: ${outputPath}`);
