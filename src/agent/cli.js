#!/usr/bin/env node
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateDevice } from "./deviceStore.js";
import { createAgentClient, startRealtimeAgent } from "./realtimeAgent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../..", ".env") });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const email = process.env.VOICEBRIDGE_AGENT_EMAIL;
const password = process.env.VOICEBRIDGE_AGENT_PASSWORD;

if (!supabaseUrl || !supabaseAnonKey || !email || !password) {
  console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, VOICEBRIDGE_AGENT_EMAIL, or VOICEBRIDGE_AGENT_PASSWORD.");
  process.exit(1);
}

const supabase = createAgentClient({ supabaseUrl, supabaseAnonKey });
const { data, error } = await supabase.auth.signInWithPassword({ email, password });

if (error) {
  console.error(error.message);
  process.exit(1);
}

const device = await loadOrCreateDevice();
const { error: upsertError } = await supabase.from("devices").upsert({
  id: device.id,
  user_id: data.user.id,
  name: device.name,
  device_type: "desktop",
  platform: device.platform,
  status: "active",
  last_seen_at: new Date().toISOString()
});

if (upsertError) {
  console.error(`Failed to register device: ${upsertError.message}`);
  process.exit(1);
}

console.log(`VoiceBridge Agent online as ${device.name} (${device.id})`);
await startRealtimeAgent({
  supabase,
  userId: data.user.id,
  device,
  onStatus: console.log
});
