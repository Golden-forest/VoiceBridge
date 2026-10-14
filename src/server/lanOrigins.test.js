import test from "node:test";
import assert from "node:assert/strict";
import { isTrustedLanOrigin } from "./lanOrigins.js";

test("LAN Origin policy accepts exact local page/native origins and rejects lookalikes", () => {
  const policy = { hosts: ["localhost", "127.0.0.1", "192.168.1.3"], port: 3000 };
  const trusted = (origin) => isTrustedLanOrigin({ headers: origin === undefined ? {} : { origin } }, policy);
  for (const origin of [undefined, "capacitor://localhost", "http://localhost", "https://localhost",
    "https://192.168.1.3:3000", "https://localhost:3000"]) assert.equal(trusted(origin), true, String(origin));
  for (const origin of ["null", "", "https://evil.test", "https://localhost:3002", "http://192.168.1.3:3000",
    "https://localhost.evil.test:3000", "https://192.168.1.3:3000/path"]) assert.equal(trusted(origin), false, origin);
});
