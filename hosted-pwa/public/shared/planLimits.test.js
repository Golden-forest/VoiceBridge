import test from "node:test";
import assert from "node:assert/strict";
import { getPlanLimit, isPaidStatus } from "./planLimits.js";

test("getPlanLimit returns free fallback", () => {
  assert.deepEqual(getPlanLimit("unknown"), {
    monthlySeconds: 600,
    maxAudioSeconds: 60,
    rateLimitPerMinute: 10
  });
});

test("paid statuses are trialing and active only", () => {
  assert.equal(isPaidStatus("trialing"), true);
  assert.equal(isPaidStatus("active"), true);
  assert.equal(isPaidStatus("past_due"), false);
  assert.equal(isPaidStatus("canceled"), false);
});
