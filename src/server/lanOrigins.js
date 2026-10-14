export const NATIVE_LAN_ORIGINS = new Set([
  "capacitor://localhost", "http://localhost", "https://localhost"
]);

// Browsers always attach Origin to WebSocket upgrades. Native/CLI clients may
// omit it, but must still satisfy the separate pairing-token check.
export function isTrustedLanOrigin(req, { hosts = [], port } = {}) {
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  if (typeof origin !== "string" || !origin) return false;
  if (NATIVE_LAN_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" &&
      Number(url.port || 443) === port &&
      hosts.includes(url.hostname) &&
      url.origin === origin;
  } catch {
    return false;
  }
}
