import test from "node:test";
import assert from "node:assert/strict";

import {
  createAsrTextOutputBuffer,
  stripTrailingAsrPunctuation
} from "./asrTextOutputBuffer.js";

function createManualScheduler() {
  const timers = [];
  return {
    timers,
    setTimer(fn, ms) {
      const timer = { fn, ms, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.active = false;
    },
    async runLastTimer() {
      const timer = timers.at(-1);
      assert.ok(timer, "expected a scheduled timer");
      assert.equal(timer.active, true);
      timer.active = false;
      await timer.fn();
    }
  };
}

test("stripTrailingAsrPunctuation removes ASR-added sentence endings only from the end", () => {
  assert.equal(stripTrailingAsrPunctuation("我想一下。"), "我想一下");
  assert.equal(stripTrailingAsrPunctuation("继续说，"), "继续说");
  assert.equal(stripTrailingAsrPunctuation("内部，标点保留。"), "内部，标点保留");
  assert.equal(stripTrailingAsrPunctuation("句号。"), "句号");
});

test("ASR output stays in a local buffer, merges nearby text, then flushes once after idle", async () => {
  let now = 1_000;
  const outputs = [];
  const scheduler = createManualScheduler();
  const buffer = createAsrTextOutputBuffer({
    flushDelayMs: 2_800,
    mergeWindowMs: 2_000,
    now: () => now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    outputTextFn: async (text, options) => {
      outputs.push({ text, options });
      return { copied: true, pasted: true, pasteError: null };
    }
  });

  const first = await buffer.handleText("我想一下。", {
    autoPaste: true,
    targetWindow: { appName: "Notes", windowTitle: "Draft" }
  });

  assert.equal(first.buffered, true);
  assert.equal(first.flushed, false);
  assert.deepEqual(outputs, []);
  assert.equal(buffer.getState().buffer, "我想一下");
  assert.equal(scheduler.timers.at(-1).ms, 2_800);

  now += 1_500;
  const second = await buffer.handleText("继续说，", {
    autoPaste: true,
    targetWindow: { appName: "Notes", windowTitle: "Draft" }
  });

  assert.equal(second.buffered, true);
  assert.deepEqual(outputs, []);
  assert.equal(buffer.getState().buffer, "我想一下继续说");

  await scheduler.runLastTimer();

  assert.deepEqual(outputs, [
    {
      text: "我想一下继续说",
      options: {
        autoPaste: true,
        targetWindow: { appName: "Notes", windowTitle: "Draft" }
      }
    }
  ]);
  assert.equal(buffer.getState().buffer, "");
});

test("ASR buffer handles simple voice commands before text reaches the computer input", async () => {
  const outputs = [];
  const keypresses = [];
  const scheduler = createManualScheduler();
  const buffer = createAsrTextOutputBuffer({
    now: () => 1_000,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    outputTextFn: async (text) => {
      outputs.push(text);
      return { copied: true, pasted: true, pasteError: null };
    },
    pressEnterFn: async () => keypresses.push("enter"),
    pressDeleteFn: async () => keypresses.push("delete")
  });

  await buffer.handleText("你好，");
  await buffer.handleText("逗号。");
  await buffer.handleText("世界。");
  await buffer.handleText("句号。");
  await buffer.handleText("换行。");
  await buffer.handleText("删除。");

  assert.equal(buffer.getState().buffer, "你好，世界。");
  assert.deepEqual(outputs, []);
  assert.deepEqual(keypresses, []);

  await buffer.handleText("发送。");

  assert.deepEqual(outputs, ["你好，世界。"]);
  assert.deepEqual(keypresses, ["enter"]);
  assert.equal(buffer.getState().buffer, "");

  await buffer.handleText("草稿。");
  await buffer.handleText("清空。");

  assert.equal(scheduler.timers.at(-1).active, false);
  assert.deepEqual(outputs, ["你好，世界。"]);
  assert.equal(buffer.getState().buffer, "");

  await buffer.handleText("删除。");

  assert.deepEqual(keypresses, ["enter", "delete"]);
});
