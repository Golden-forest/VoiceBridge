import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputPath = path.resolve("src/agent/electron/desktop-config.json");
const existingConfig = await readExistingConfig(outputPath);
const supabaseUrl = process.env.VOICEBRIDGE_DESKTOP_SUPABASE_URL
  || process.env.SUPABASE_URL
  || existingConfig.supabaseUrl
  || "https://gqxxknusznbunkiznnal.supabase.co";
const supabaseAnonKey = process.env.VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY
  || process.env.SUPABASE_ANON_KEY
  || existingConfig.supabaseAnonKey
  || "";
const webAppUrl = process.env.VOICEBRIDGE_WEB_APP_URL
  || existingConfig.webAppUrl
  || "https://voicebridge-6kr.pages.dev";

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Missing VOICEBRIDGE_DESKTOP_SUPABASE_URL or VOICEBRIDGE_DESKTOP_SUPABASE_ANON_KEY for Electron packaging."
  );
  console.error("These are public Supabase client values, not service secrets.");
  process.exit(1);
}

const payload = {
  supabaseUrl,
  supabaseAnonKey,
  webAppUrl
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote Electron desktop public config: ${outputPath}`);

async function readExistingConfig(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
