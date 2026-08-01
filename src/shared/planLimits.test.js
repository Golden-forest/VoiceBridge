import test from "node:test";
import assert from "node:assert/strict";
import { getPlanLimit, isPaidStatus, isAdminPlan } from "./planLimits.js";

test("getPlanLimit returns free fallback with millisecond audio cap", () => {
  assert.deepEqual(getPlanLimit("unknown"), {
    monthlySeconds: 600,
    maxAudioSeconds: 15,
    maxAudioMs: 15_000,
    rateLimitPerMinute: 10
  });
});

test("paid statuses are trialing and active only", () => {
  assert.equal(isPaidStatus("trialing"), true);
  assert.equal(isPaidStatus("active"), true);
  assert.equal(isPaidStatus("past_due"), false);
  assert.equal(isPaidStatus("canceled"), false);
});

test("isAdminPlan detects admin tier", () => {
  assert.equal(isAdminPlan("admin"), true);
  assert.equal(isAdminPlan("pro"), false);
  assert.equal(isAdminPlan("free"), false);
  assert.equal(isAdminPlan(undefined), false);
});
