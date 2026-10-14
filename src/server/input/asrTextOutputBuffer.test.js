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

test("stripTrailingAsrPunctuation removes trailing punctuation only", () => {
  assert.equal(stripTrailingAsrPunctuation("我想一下。"), "我想一下");
  assert.equal(stripTrailingAsrPunctuation("继续说，"), "继续说");
  assert.equal(stripTrailingAsrPunctuation("内部，标点保留。"), "内部，标点保留");
  assert.equal(stripTrailingAsrPunctuation("句号。"), "句号");
});

test("buffer preserves ASR punctuation, does not strip or add", async () => {
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
      assert.equal(typeof options.isActive, "function");
      const { isActive, ...outputOptions } = options;
      outputs.push({ text, options: outputOptions });
      return { copied: true, pasted: true, pasteError: null };
    }
  });

  // ASR 返回带标点的文本 → 原样保留
  const first = await buffer.handleText("我想一下。", {
    autoPaste: true,
    targetWindow: { appName: "Notes", windowTitle: "Draft" }
  });

  // 句末标点触发即时 flush
  assert.equal(first.flushed, true);
  assert.deepEqual(outputs, [
    {
      text: "我想一下。",
      options: {
        autoPaste: true,
        targetWindow: { appName: "Notes", windowTitle: "Draft" }
      }
    }
  ]);
  assert.equal(buffer.getState().buffer, "");
});

test("buffer merges nearby text without modifying punctuation", async () => {
  let now = 1_000;
  const outputs = [];
  const scheduler = createManualScheduler();
  const buffer = createAsrTextOutputBuffer({
    flushDelayMs: 2_800,
    mergeWindowMs: 2_000,
    now: () => now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    outputTextFn: async (text) => {
      outputs.push(text);
      return { copied: true, pasted: true, pasteError: null };
    }
  });

  // 无句末标点 → 进 buffer
  await buffer.handleText("我想一下");
  assert.equal(buffer.getState().buffer, "我想一下");

  now += 1_500;
  await buffer.handleText("继续说");
  assert.equal(buffer.getState().buffer, "我想一下继续说");

  await scheduler.runLastTimer();

  // 不再自动补句号
  assert.deepEqual(outputs, ["我想一下继续说"]);
  assert.equal(buffer.getState().buffer, "");
});

test("buffer handles voice commands correctly", async () => {
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

  await buffer.handleText("你好");
  assert.equal(buffer.getState().buffer, "你好");

  // 语音命令"逗号"→ 插入中文逗号（不触发即时 flush，逗号不是句末标点）
  await buffer.handleText("逗号。");
  assert.equal(buffer.getState().buffer, "你好，");

  // 重新开始测试句号命令
  outputs.length = 0;
  keypresses.length = 0;
  buffer.clear();

  await buffer.handleText("你好");
  assert.equal(buffer.getState().buffer, "你好");

  // "句号。"→ 语音命令，插入句号 → 触发即时 flush
  const r = await buffer.handleText("句号。");
  assert.equal(r.flushed, true);
  assert.deepEqual(outputs, ["你好。"]);
  assert.equal(buffer.getState().buffer, "");

  // "换行。"→ 插入换行
  await buffer.handleText("换行。");
  assert.equal(buffer.getState().buffer, "\n");

  // "删除。"→ buffer 非空 → 删 buffer 最后一个字符
  buffer.clear();
  await buffer.handleText("测试文本");
  await buffer.handleText("删除。");
  assert.equal(buffer.getState().buffer, "测试文");

  // "发送。"→ flush + Enter
  buffer.clear();
  outputs.length = 0;
  await buffer.handleText("你好世界");
  await buffer.handleText("发送。");
  assert.deepEqual(outputs, ["你好世界"]);
  assert.deepEqual(keypresses, ["enter"]);

  // "清空。"→ 清空 buffer
  buffer.clear();
  outputs.length = 0;
  await buffer.handleText("草稿内容");
  await buffer.handleText("清空。");
  assert.equal(buffer.getState().buffer, "");
  assert.deepEqual(outputs, []);
});

test("sentence-ending punctuation triggers instant flush", async () => {
  const outputs = [];
  const scheduler = createManualScheduler();
  const buf = createAsrTextOutputBuffer({
    now: () => 1_000,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    outputTextFn: async (text) => {
      outputs.push(text);
      return { copied: true, pasted: true, pasteError: null };
    }
  });

  // ASR 返回带句号的文本 → 即时 flush，原样输出
  const r1 = await buf.handleText("你好世界。");
  assert.equal(r1.flushed, true);
  assert.deepEqual(outputs, ["你好世界。"]);
  assert.equal(buf.getState().buffer, "");

  // 问号同理
  outputs.length = 0;
  const r2 = await buf.handleText("是吗？");
  assert.equal(r2.flushed, true);
  assert.deepEqual(outputs, ["是吗？"]);

  // 无句末标点 → 进 buffer，不 flush
  outputs.length = 0;
  const r3 = await buf.handleText("今天天气不错");
  assert.equal(r3.flushed, false);
  assert.equal(r3.buffered, true);
});

test("idle punctuation output is canceled when its original socket loses permission", async () => {
  let active = true;
  const scheduler = createManualScheduler();
  const outputs = [];
  const buffer = createAsrTextOutputBuffer({ setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer,
    outputTextFn: async (text) => { outputs.push(text); return { copied: true }; } });
  await buffer.handleText("逗号", { autoPaste: true, isActive: () => active });
  active = false;
  await scheduler.runLastTimer();
  assert.deepEqual(outputs, []);
  assert.equal(buffer.getState().buffer, "");
});

test("a target change flushes the earlier buffer to its original window", async () => {
  const scheduler = createManualScheduler();
  const outputs = [];
  const buffer = createAsrTextOutputBuffer({ setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer,
    outputTextFn: async (text, options) => { outputs.push([text, options.targetWindow.windowTitle]); return { copied: true }; } });
  await buffer.handleText("旧草稿", { autoPaste: true, targetWindow: { appName: "Notes", windowTitle: "A" } });
  await buffer.handleText("新草稿", { autoPaste: true, targetWindow: { appName: "Notes", windowTitle: "B" }, immediate: true });
  assert.deepEqual(outputs, [["旧草稿", "A"], ["新草稿", "B"]]);
});

test("independent phones cannot merge their buffered text even when the target window matches", async () => {
  const scheduler = createManualScheduler();
  const outputs = [];
  const buffer = createAsrTextOutputBuffer({ setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer,
    outputTextFn: async (text) => { outputs.push(text); return { copied: true }; } });
  const targetWindow = { appName: "Notes", windowTitle: "Shared" };
  await buffer.handleText("手机一", { sourceIdentity: "phone-1", targetWindow });
  await buffer.handleText("手机二", { sourceIdentity: "phone-2", targetWindow });
  assert.deepEqual(outputs, ["手机一"]);
  await scheduler.runLastTimer();
  assert.deepEqual(outputs, ["手机一", "手机二"]);
});

test("voice keys refuse to act when their selected window cannot be activated", async () => {
  let keys = 0;
  const buffer = createAsrTextOutputBuffer({ pressEnterFn: async () => { keys++; },
    activateWindowFn: async () => ({ success: false, error: "window closed" }), logger: { warn() {} } });
  const result = await buffer.handleText("发送", { targetWindow: { appName: "Notes", windowTitle: "Gone" } });
  assert.equal(keys, 0);
  assert.equal(result.keyPressed, false);
  assert.equal(result.keyError, "window closed");
});
