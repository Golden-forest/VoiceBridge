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
      text: "我想一下继续说。",
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
  // buffer = "你好，" — 无句末标点，不即时 flush
  assert.equal(buffer.getState().buffer, "你好，");
  assert.deepEqual(outputs, []);

  await buffer.handleText("世界。");
  // buffer = "你好，世界" — 无句末标点，不即时 flush
  assert.equal(buffer.getState().buffer, "你好，世界");
  assert.deepEqual(outputs, []);

  await buffer.handleText("句号。");
  // buffer = "你好，世界。" — 以句末标点结尾，即时 flush
  assert.deepEqual(outputs, ["你好，世界。"]);
  assert.equal(buffer.getState().buffer, "");

  await buffer.handleText("换行。");
  // buffer = "\n" — 换行不以句末标点结尾，不即时 flush
  assert.equal(buffer.getState().buffer, "\n");

  await buffer.handleText("删除。");
  // 删除命令：buffer "\n" 的最后一个字符被删除，buffer 变为空
  assert.equal(buffer.getState().buffer, "");
  assert.deepEqual(keypresses, []);

  // 发送命令：buffer 为空，无内容可 flush，但仍然按回车
  await buffer.handleText("发送。");
  assert.deepEqual(keypresses, ["enter"]);

  await buffer.handleText("草稿。");
  await buffer.handleText("清空。");

  assert.equal(scheduler.timers.at(-1).active, false);
  assert.deepEqual(outputs, ["你好，世界。"]);
  assert.equal(buffer.getState().buffer, "");

  await buffer.handleText("删除。");

  assert.deepEqual(keypresses, ["enter", "delete"]);
});

test("auto-append period on flush when text has no ending punctuation", async () => {
  const outputs = [];
  const scheduler = createManualScheduler();
  const buffer = createAsrTextOutputBuffer({
    now: () => 1_000,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    outputTextFn: async (text) => {
      outputs.push(text);
      return { copied: true, pasted: true, pasteError: null };
    }
  });

  // 无标点 → 自动补句号
  await buffer.handleText("今天天气不错");
  await scheduler.runLastTimer();
  assert.deepEqual(outputs, ["今天天气不错。"]);

  // 已有句号 → 不重复
  outputs.length = 0;
  await buffer.handleText("你好，世界。");
  await scheduler.runLastTimer();
  assert.deepEqual(outputs, ["你好，世界。"]);

  // 以换行结尾 → 仍然补句号
  outputs.length = 0;
  await buffer.handleText("第一行\n第二行");
  await scheduler.runLastTimer();
  assert.deepEqual(outputs, ["第一行\n第二行。"]);

  // ASR 返回的？会被 stripTrailingAsrPunctuation 剥离，所以仍然补句号
  outputs.length = 0;
  await buffer.handleText("你好吗？");
  await scheduler.runLastTimer();
  assert.deepEqual(outputs, ["你好吗。"]);

  // ASR 返回的！同样被剥离，补句号
  outputs.length = 0;
  await buffer.handleText("太好了！");
  await scheduler.runLastTimer();
  assert.deepEqual(outputs, ["太好了。"]);

  // 英文句号结尾 → 被剥离，补中文句号
  outputs.length = 0;
  await buffer.handleText("Hello world.");
  await scheduler.runLastTimer();
  assert.deepEqual(outputs, ["Hello world。"]);

  // 通过语音命令"句号"插入的句号 → 即时 flush，无需等待定时器
  outputs.length = 0;
  await buffer.handleText("用户说了句号");
  await buffer.handleText("句号。");
  assert.deepEqual(outputs, ["用户说了句号。"]);
  assert.equal(buffer.getState().buffer, "");
});

test("instant flush when buffer ends with sentence-ending punctuation", async () => {
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

  // 场景 1：通过语音命令"句号"插入 。→ 即时 flush
  await buf.handleText("你好世界");
  assert.equal(buf.getState().buffer, "你好世界");
  assert.equal(scheduler.timers.at(-1).active, true);

  const r1 = await buf.handleText("句号。");
  assert.equal(r1.flushed, true);
  assert.equal(r1.buffered, false);
  assert.deepEqual(outputs, ["你好世界。"]);
  assert.equal(buf.getState().buffer, "");
  assert.equal(buf.getState().hasPendingFlush, false);

  // 场景 2：buffer 为空，普通文本（ASR 剥离标点后无句末标点）→ 不即时 flush
  outputs.length = 0;
  const r2 = await buf.handleText("今天天气不错");
  assert.equal(r2.flushed, false);
  assert.equal(r2.buffered, true);
  assert.equal(buf.getState().buffer, "今天天气不错");
  assert.equal(buf.getState().hasPendingFlush, true);

  // 场景 3：追加文本后 buffer 仍无句末标点 → 不即时 flush，定时器被重置
  outputs.length = 0;
  const prevTimer = scheduler.timers.at(-1);
  const r3 = await buf.handleText("真好");
  assert.equal(r3.flushed, false);
  assert.equal(r3.buffered, true);
  assert.equal(buf.getState().buffer, "今天天气不错真好");
  // 之前的定时器应被 cancel，新的定时器被设置
  assert.equal(prevTimer.active, false);
  assert.equal(scheduler.timers.at(-1).active, true);

  // 场景 4：中间有逗号命令，但无句末标点 → 不即时 flush
  outputs.length = 0;
  await buf.handleText("逗号。");
  assert.equal(buf.getState().buffer, "今天天气不错真好，");
  assert.equal(outputs.length, 0);

  // 场景 5：最终通过句号命令插入句末标点 → 即时 flush，定时器被取消
  outputs.length = 0;
  const timerBeforePeriod = scheduler.timers.at(-1);
  const r5 = await buf.handleText("句号。");
  assert.equal(r5.flushed, true);
  assert.equal(r5.buffered, false);
  assert.deepEqual(outputs, ["今天天气不错真好，。"]);
  assert.equal(buf.getState().buffer, "");
  assert.equal(timerBeforePeriod.active, false);
});
