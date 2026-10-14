import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

// Default is read-only. The optional authorization probe is a real PATCH and
// must never be included in offline verification or mistaken for a rollback.
export async function verifyProduction({ config, device, accessToken, fetchImpl = fetch, checkWriteAuthorization = false }) {
  const headers = {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };
  const response = await fetchImpl(`${config.supabaseUrl}/functions/v1/device-pairing`, {
    method: "POST", headers,
    body: JSON.stringify({ action: "status", device_id: device.id }),
    signal: AbortSignal.timeout(15_000)
  });
  const pairing = await response.json().catch(() => null);
  const result = {
    mode: checkWriteAuthorization ? "authorization-write-probe" : "read-only",
    pairing_http: response.status,
    paired: Boolean(pairing?.paired),
    plan: typeof pairing?.plan === "string" ? pairing.plan : null,
    sensitive_device_update_blocked: null
  };
  if (checkWriteAuthorization && response.ok && pairing?.paired && pairing.user_id) {
    const probe = await fetchImpl(`${config.supabaseUrl}/rest/v1/devices?id=eq.${encodeURIComponent(device.id)}`, {
      method: "PATCH", headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: pairing.user_id }),
      signal: AbortSignal.timeout(15_000)
    });
    result.sensitive_device_update_blocked = [401, 403].includes(probe.status);
  }
  result.ok = response.ok && result.paired && ["free", "pro", "admin"].includes(result.plan)
    && (!checkWriteAuthorization || result.sensitive_device_update_blocked === true);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--check-write-authorization");
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(", ")}`);
  const config = JSON.parse(await readFile(new URL("../src/agent/electron/desktop-config.json", import.meta.url), "utf8"));
  const stateDir = process.env.VOICEBRIDGE_STATE_DIR || path.join(os.homedir(), ".voicebridge");
  const device = JSON.parse(await readFile(path.join(stateDir, "device.json"), "utf8"));
  const values = JSON.parse(await readFile(path.join(stateDir, "auth-storage.json"), "utf8"));
  const session = Object.values(values).filter((value) => typeof value === "string").map((value) => {
    try { return JSON.parse(value); } catch { return null; }
  }).find((value) => typeof value?.access_token === "string");
  if (!session) throw new Error("No desktop runtime session found");
  const result = await verifyProduction({ config, device, accessToken: session.access_token,
    checkWriteAuthorization: process.argv.includes("--check-write-authorization") });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
