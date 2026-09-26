import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../src/agent/electron/desktop-config.json", import.meta.url), "utf8"));
const stateDir = process.env.VOICEBRIDGE_STATE_DIR || `${process.env.USERPROFILE || process.env.HOME}/.voicebridge`;
const device = JSON.parse(await readFile(`${stateDir}/device.json`, "utf8"));
const authValues = JSON.parse(await readFile(`${stateDir}/auth-storage.json`, "utf8"));
const projectRef = new URL(config.supabaseUrl).hostname.split(".")[0];
const candidateSessions = [authValues[`sb-${projectRef}-auth-token`], ...Object.values(authValues)];
const storedSession = candidateSessions
  .filter((value) => typeof value === "string")
  .map((value) => {
    try { return JSON.parse(value); } catch { return null; }
  })
  .find((value) => typeof value?.access_token === "string");
if (!storedSession) throw new Error("No desktop runtime session found");

const headers = {
  apikey: config.supabaseAnonKey,
  Authorization: `Bearer ${storedSession.access_token}`,
  "Content-Type": "application/json"
};
const invoke = async (name, body) => {
  const response = await fetch(`${config.supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const pairing = await invoke("device-pairing", { action: "status", device_id: device.id });
const issue = await invoke("issue-asr-request", {
  device_id: device.id,
  duration_ms: 60_000,
  audio_size_bytes: 1_920_000
});
const report = issue.body?.request_id
  ? await invoke("report-asr-result", {
      device_id: device.id,
      request_id: issue.body.request_id,
      status: "failed",
      error_code: "release_verification"
    })
  : null;
const sensitiveUpdate = await fetch(`${config.supabaseUrl}/rest/v1/devices?id=eq.${encodeURIComponent(device.id)}`, {
  method: "PATCH",
  headers: {
    ...headers,
    Prefer: "tx=rollback,return=minimal"
  },
  body: JSON.stringify({ user_id: pairing.body?.user_id }),
  signal: AbortSignal.timeout(15_000)
});

const result = {
  pairing_http: pairing.status,
  paired: Boolean(pairing.body?.paired),
  plan: typeof pairing.body?.plan === "string" ? pairing.body.plan : null,
  max_duration_ms: ["admin", "pro"].includes(pairing.body?.plan) ? 60_000 : 15_000,
  issue_http: issue.status,
  issue_ok: Boolean(issue.body?.ok),
  report_http: report?.status || null,
  report_ok: Boolean(report?.body?.ok),
  sensitive_device_update_blocked: [401, 403].includes(sensitiveUpdate.status)
};
console.log(JSON.stringify(result));
if (!result.paired || result.plan !== "admin" || !result.issue_ok || !result.report_ok || !result.sensitive_device_update_blocked) {
  process.exitCode = 1;
}
