import { pressDelete, pressEnter } from "./paste.js";
import { outputText } from "./outputText.js";
import { assertInputActive, runDesktopInputOperation } from "./desktopInputQueue.js";
import { activateWindow } from "./windowManager.js";

const DEFAULT_FLUSH_DELAY_MS = 2_800;
const DEFAULT_MERGE_WINDOW_MS = 2_000;
const TRAILING_ASR_PUNCTUATION_RE = /[\s。．.，,、；;：:？！!?…]+$/u;
const SENTENCE_END_RE = /[。．.！!？?]$/;

const COMMANDS = new Map([
  ["句号", { name: "period", insert: "。" }],
  ["逗号", { name: "comma", insert: "，" }],
  ["换行", { name: "newline", insert: "\n" }],
  ["发送", { name: "send" }],
  ["删除", { name: "delete" }],
  ["清空", { name: "clear" }]
]);

export function stripTrailingAsrPunctuation(text) {
  if (typeof text !== "string") return "";
  return text.trim().replace(TRAILING_ASR_PUNCTUATION_RE, "").trimEnd();
}

export function parseVoiceCommand(text) {
  const normalized = stripTrailingAsrPunctuation(text).replace(/\s+/g, "");
  return COMMANDS.get(normalized) || null;
}

export function createAsrTextOutputBuffer({
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  mergeWindowMs = DEFAULT_MERGE_WINDOW_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  outputTextFn = outputText,
  pressEnterFn = pressEnter,
  pressDeleteFn = pressDelete,
  onFlush = () => {},
  logger = console,
  isActive = () => true,
  activateWindowFn = activateWindow
} = {}) {
  let buffer = "";
  let lastInputAt = null;
  let flushTimer = null;
  let pendingOptions = defaultOutputOptions();
  let bufferSource = null;

  async function handleText(rawText, options = {}) {
    // 信任 ASR 返回的标点，不做 strip
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) {
      return buildResult({ text, buffered: Boolean(buffer) });
    }

    if (buffer && !pendingOptions.isActive()) resetBuffer();
    const nextOptions = normalizeOutputOptions(options);
    if (buffer && (bufferSource !== (options.sourceIdentity || null) ||
        JSON.stringify(pendingOptions.targetWindow) !== JSON.stringify(nextOptions.targetWindow) ||
        pendingOptions.autoPaste !== nextOptions.autoPaste)) {
      await flushPending({ reason: "output-target-changed" });
    }

    // 语音命令需要 strip 标点来匹配（如"句号。"→"句号"）
    const command = parseVoiceCommand(text);
    if (command) {
      return handleCommand(command, text, options);
    }

    await appendToBuffer(text, options);

    // handleText 是唯一的 flush 决策点：
    // 1. immediate（录音停止）→ 立即 flush
    // 2. 句末标点 → 立即 flush
    // 3. 其他 → 等定时器
    const shouldFlush = options.immediate || SENTENCE_END_RE.test(buffer);
    if (shouldFlush) {
      return flushPending({ reason: options.immediate ? "immediate" : "sentence-end" });
    }

    return buildResult({ text, buffered: true, output: pendingOutput(true) });
  }

  async function appendToBuffer(text, options) {
    const nextOptions = normalizeOutputOptions(options);
    const currentTime = now();
    if (
      buffer &&
      lastInputAt !== null &&
      currentTime - lastInputAt > mergeWindowMs
    ) {
      await flushPending({ reason: "merge-window-expired" });
    }

    buffer += text;
    bufferSource = options.sourceIdentity || null;
    lastInputAt = currentTime;
    pendingOptions = nextOptions;
    scheduleFlush();
  }

  async function handleCommand(command, text, options) {
    if (command.insert) {
      await appendToBuffer(command.insert, options);
      // 句末标点（。！？）触发立即 flush，其他（，、\n）等定时器
      if (SENTENCE_END_RE.test(buffer)) {
        const result = await flushPending({ reason: "insert-command" });
        result.command = command.name;
        return result;
      }
      return buildResult({
        text,
        command: command.name,
        buffered: true,
        output: pendingOutput(true)
      });
    }

    if (command.name === "send") {
      const flushResult = await flushPending({ reason: "send-command" });
      const keyError = await pressKey(pressEnterFn, options);
      return buildResult({
        text,
        command: command.name,
        buffered: false,
        flushed: flushResult.flushed,
        output: flushResult.output,
        keyPressed: !keyError,
        keyError
      });
    }

    if (command.name === "delete") {
      if (buffer) {
        buffer = Array.from(buffer).slice(0, -1).join("");
        if (buffer) {
          lastInputAt = now();
          pendingOptions = normalizeOutputOptions(options);
          scheduleFlush();
        } else {
          resetBuffer();
        }
        return buildResult({
          text,
          command: command.name,
          buffered: Boolean(buffer),
          output: pendingOutput(Boolean(buffer))
        });
      }

      const keyError = await pressKey(pressDeleteFn, options);
      return buildResult({
        text,
        command: command.name,
        buffered: false,
        keyPressed: !keyError,
        keyError
      });
    }

    if (command.name === "clear") {
      resetBuffer();
      return buildResult({
        text,
        command: command.name,
        buffered: false
      });
    }

    return buildResult({ text, buffered: Boolean(buffer) });
  }

  async function flushPending({ reason = "manual" } = {}) {
    if (buffer && (!isActive() || !pendingOptions.isActive())) resetBuffer();
    if (!buffer) {
      return buildResult({ text: "", flushed: false, buffered: false });
    }

    cancelFlush();
    const text = buffer;
    const options = pendingOptions;
    buffer = "";
    bufferSource = null;
    lastInputAt = null;
    pendingOptions = defaultOutputOptions();

    const output = await writeOutput(text, options);
    const result = buildResult({
      text,
      buffered: false,
      flushed: true,
      output: { ...output, buffered: false },
      reason
    });
    onFlush(result);
    return result;
  }

  function scheduleFlush() {
    cancelFlush();
    flushTimer = setTimer(async () => {
      flushTimer = null;
      try {
        await runDesktopInputOperation(() => {
          assertInputActive(isActive);
          return flushPending({ reason: "idle" });
        });
      } catch (error) {
        resetBuffer();
        logger.warn?.(`Buffered ASR flush canceled: ${error.message}`);
      }
    }, flushDelayMs);
  }

  function cancelFlush() {
    if (flushTimer) {
      clearTimer(flushTimer);
      flushTimer = null;
    }
  }

  function resetBuffer() {
    cancelFlush();
    buffer = "";
    bufferSource = null;
    lastInputAt = null;
    pendingOptions = defaultOutputOptions();
  }

  async function writeOutput(text, options) {
    try {
      const operationIsActive = () => isActive() && options.isActive();
      assertInputActive(operationIsActive);
      return await outputTextFn(text, { ...options, isActive: operationIsActive });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`Buffered ASR output failed: ${message}`);
      return {
        copied: false,
        pasted: false,
        pasteError: message
      };
    }
  }

  async function pressKey(fn, options) {
    try {
      const normalized = normalizeOutputOptions(options);
      const operationIsActive = () => isActive() && normalized.isActive();
      assertInputActive(operationIsActive);
      if (options.targetWindow?.appName) {
        const result = await activateWindowFn(options.targetWindow.appName, options.targetWindow.windowTitle);
        if (result?.success === false) throw new Error(result.error || "无法激活目标窗口");
        assertInputActive(operationIsActive);
      }
      await fn();
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`Voice command key press failed: ${message}`);
      return message;
    }
  }

  function getState() {
    return {
      buffer,
      hasPendingFlush: Boolean(flushTimer),
      lastInputAt
    };
  }

  return {
    handleText: (...args) => runDesktopInputOperation(() => {
      assertInputActive(isActive);
      assertInputActive(normalizeOutputOptions(args[1] || {}).isActive);
      return handleText(...args);
    }),
    flush: (...args) => runDesktopInputOperation(() => {
      assertInputActive(isActive);
      return flushPending(...args);
    }),
    clear: resetBuffer,
    getState
  };
}

function buildResult({
  text,
  command = null,
  buffered = false,
  flushed = false,
  output = pendingOutput(buffered),
  reason = null,
  keyPressed = false,
  keyError = null
}) {
  return {
    text,
    command,
    buffered,
    flushed,
    output,
    reason,
    keyPressed,
    keyError
  };
}

function pendingOutput(buffered) {
  return {
    copied: false,
    pasted: false,
    pasteError: null,
    buffered
  };
}

function normalizeOutputOptions(options) {
  return {
    autoPaste: Boolean(options.autoPaste),
    targetWindow: options.targetWindow || null,
    isActive: typeof options.isActive === "function" ? options.isActive : alwaysActive
  };
}

function defaultOutputOptions() {
  return {
    autoPaste: false,
    targetWindow: null,
    isActive: alwaysActive
  };
}

function alwaysActive() { return true; }
