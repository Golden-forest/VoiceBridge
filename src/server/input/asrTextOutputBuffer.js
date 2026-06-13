import { pressDelete, pressEnter } from "./paste.js";
import { outputText } from "./outputText.js";

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
  logger = console
} = {}) {
  let buffer = "";
  let lastInputAt = null;
  let flushTimer = null;
  let pendingOptions = defaultOutputOptions();

  async function handleText(rawText, options = {}) {
    const text = stripTrailingAsrPunctuation(rawText);
    if (!text) {
      return buildResult({ text, buffered: Boolean(buffer) });
    }

    const command = parseVoiceCommand(text);
    if (command) {
      return handleCommand(command, text, options);
    }

    return appendToBuffer(text, options, { honorMergeWindow: true });
  }

  async function appendToBuffer(text, options, { honorMergeWindow, command = null } = {}) {
    const currentTime = now();
    if (
      honorMergeWindow &&
      buffer &&
      lastInputAt !== null &&
      currentTime - lastInputAt > mergeWindowMs
    ) {
      await flushPending({ reason: "merge-window-expired" });
    }

    buffer += text;
    lastInputAt = currentTime;
    pendingOptions = normalizeOutputOptions(options);
    scheduleFlush();

    return buildResult({
      text,
      command,
      buffered: true,
      output: pendingOutput(true)
    });
  }

  async function handleCommand(command, text, options) {
    if (command.insert) {
      return appendToBuffer(command.insert, options, {
        honorMergeWindow: false,
        command: command.name
      });
    }

    if (command.name === "send") {
      const flushResult = await flushPending({ reason: "send-command" });
      const keyError = await pressKey(pressEnterFn);
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

      const keyError = await pressKey(pressDeleteFn);
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
    if (!buffer) {
      return buildResult({ text: "", flushed: false, buffered: false });
    }

    cancelFlush();
    let text = buffer;
    if (!SENTENCE_END_RE.test(text)) text += "。";
    const options = pendingOptions;
    buffer = "";
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
      await flushPending({ reason: "idle" });
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
    lastInputAt = null;
    pendingOptions = defaultOutputOptions();
  }

  async function writeOutput(text, options) {
    try {
      return await outputTextFn(text, options);
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

  async function pressKey(fn) {
    try {
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
    handleText,
    flush: flushPending,
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
    targetWindow: options.targetWindow || null
  };
}

function defaultOutputOptions() {
  return {
    autoPaste: false,
    targetWindow: null
  };
}
