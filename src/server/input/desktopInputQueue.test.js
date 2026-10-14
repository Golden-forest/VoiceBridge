import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopInputQueue } from "./desktopInputQueue.js";

test("desktop queue orders operations and permits awaited nested helpers", async () => {
  const run = createDesktopInputQueue();
  const calls = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = run(async () => {
    calls.push("activate-A");
    await blocked;
    await run(async () => calls.push("paste-A"));
  });
  const second = run(async () => calls.push("paste-B"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["activate-A"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["activate-A", "paste-A", "paste-B"]);
});

test("a failed desktop operation does not block later operations", async () => {
  const run = createDesktopInputQueue();
  await assert.rejects(run(() => { throw new Error("denied"); }), /denied/);
  assert.equal(await run(() => "recovered"), "recovered");
});
