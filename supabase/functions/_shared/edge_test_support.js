import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { jsonResponse, corsHeaders } from "./cors.ts";

// Load an authored Deno handler unchanged except its external imports. Tests
// supply service/provider dependencies and never contact a cloud account.
export async function loadEdgeHandler(relativePath, stubs = {}) {
  let handler;
  const env = {
    SUPABASE_URL: "https://local.invalid", SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service", PADDLE_API_KEY: "dummy",
    STRIPE_SECRET_KEY: "dummy", STRIPE_WEBHOOK_SECRET: "dummy", STRIPE_PRO_MONTHLY_PRICE_ID: "price_test",
    STRIPE_SUCCESS_URL: "https://local.invalid/success", STRIPE_CANCEL_URL: "https://local.invalid/cancel",
    TENCENT_SECRET_ID: "dummy", TENCENT_SECRET_KEY: "dummy"
  };
  const source = (await readFile(new URL(relativePath, import.meta.url), "utf8"))
    .replace(/^import\s+[\s\S]*?\s+from\s+["'][^"']+["'];/gm, "");
  const background = [];
  const dependencies = {
    Deno: { serve: (fn) => { handler = fn; }, env: { get: (name) => env[name] } },
    EdgeRuntime: { waitUntil: (promise) => { background.push(promise); } },
    jsonResponse, corsHeaders, console: { info() {}, warn() {}, error() {} },
    ...stubs
  };
  new Function(...Object.keys(dependencies), stripTypeScriptTypes(source, { mode: "strip" }))(...Object.values(dependencies));
  return { handler, flush: () => Promise.all(background) };
}

export const postJson = (body = {}) => new Request("https://local.invalid/test", {
  method: "POST", headers: { Authorization: "Bearer dummy", "Content-Type": "application/json" },
  body: JSON.stringify(body)
});
