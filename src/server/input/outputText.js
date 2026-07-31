import { writeClipboard } from "./clipboard.js";
import { pasteClipboard } from "./paste.js";

export async function outputText(
  text,
  {
    autoPaste,
    clipboardWriter = defaultClipboardWriter,
    pasteFn = defaultPasteFn,
    targetWindow = null,
    activateWindowFn = defaultActivateWindowFn,
    logger = console
  } = {}
) {
  // 激活窗口与写剪贴板并行执行：pbcopy 和 osascript 互不依赖，
  // 粘贴按键在两者完成后才触发，顺序安全。
  const activatePromise = (autoPaste && targetWindow && targetWindow.appName)
    ? activateWindowFn(targetWindow.appName, targetWindow.windowTitle)
        .then((result) => {
          if (!result.success) {
            logger.warn?.(`Window activation failed: ${result.error}`);
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn?.(`Window activation error: ${message}`);
        })
    : Promise.resolve();

  await Promise.all([
    activatePromise,
    clipboardWriter(text)
  ]);

  if (!autoPaste) {
    return {
      copied: true,
      pasted: false,
      pasteError: null
    };
  }

  try {
    await pasteFn();
    return {
      copied: true,
      pasted: true,
      pasteError: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`Auto paste failed: ${message}`);
    return {
      copied: true,
      pasted: false,
      pasteError: message
    };
  }
}

async function defaultClipboardWriter(text) {
  await writeClipboard(text);
}

async function defaultPasteFn() {
  await pasteClipboard();
}

async function defaultActivateWindowFn(appName, windowTitle) {
  const { activateWindow } = await import("./windowManager.js");
  return activateWindow(appName, windowTitle);
}
