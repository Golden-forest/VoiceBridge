import assert from "node:assert/strict";
import test from "node:test";
import { loadEdgeFunctions, parseEdgeFunctions } from "./edge-functions.mjs";

test("deployment manifest covers every implemented function including account deletion", async () => {
  const functions = await loadEdgeFunctions();
  assert.deepEqual(functions.find(({ name }) => name === "account-delete"), { name: "account-delete", verifyJwt: false });
});

test("deployment manifest fails closed on missing or duplicate JWT settings", () => {
  assert.throws(() => parseEdgeFunctions("[functions.example]\n"), /Invalid function/);
  assert.throws(() => parseEdgeFunctions("[functions.example]\nverify_jwt = false\n[functions.example]\nverify_jwt = true\n"), /Invalid function/);
});
