import { writeClipboard } from "./clipboard.js";
import { pasteClipboard } from "./paste.js";
import { assertInputActive, runDesktopInputOperation } from "./desktopInputQueue.js";

export function outputText(text, options = {}) {
  return runDesktopInputOperation(() => writeOutputText(text, options));
}

async function writeOutputText(
  text,
  {
    autoPaste,
    clipboardWriter = defaultClipboardWriter,
    pasteFn = defaultPasteFn,
    targetWindow = null,
    activateWindowFn = defaultActivateWindowFn,
    logger = console,
    isActive = () => true
  } = {}
) {
  assertInputActive(isActive);
  let activationError = null;
  const activatePromise = (autoPaste && targetWindow && targetWindow.appName)
    ? activateWindowFn(targetWindow.appName, targetWindow.windowTitle)
        .then((result) => {
          if (result?.success === false) {
            activationError = result.error || "无法激活目标窗口";
            logger.warn?.(`Window activation failed: ${activationError}`);
          }
        })
        .catch((error) => {
          activationError = error instanceof Error ? error.message : String(error);
          logger.warn?.(`Window activation error: ${activationError}`);
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

  if (activationError) {
    return { copied: true, pasted: false, pasteError: activationError };
  }

  try {
    assertInputActive(isActive);
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
