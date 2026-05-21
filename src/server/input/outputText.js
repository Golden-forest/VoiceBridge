export async function outputText(
  text,
  {
    autoPaste,
    pasteDelayMs = 120,
    clipboardWriter = defaultClipboardWriter,
    pasteFn = defaultPasteFn,
    targetWindow = null,
    activateWindowFn = defaultActivateWindowFn,
    logger = console
  } = {}
) {
  // If autoPaste with a target window, activate first so clipboard write
  // happens while the correct window is becoming active.
  if (autoPaste && targetWindow && targetWindow.appName) {
    try {
      const activateResult = await activateWindowFn(
        targetWindow.appName,
        targetWindow.windowTitle
      );
      if (!activateResult.success) {
        logger.warn?.(`Window activation failed: ${activateResult.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`Window activation error: ${message}`);
    }
    await delay(200);
  }

  await clipboardWriter(text);

  if (!autoPaste) {
    return {
      copied: true,
      pasted: false,
      pasteError: null
    };
  }

  await delay(pasteDelayMs);

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

function delay(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultClipboardWriter(text) {
  const { writeClipboard } = await import("./clipboard.js");
  await writeClipboard(text);
}

async function defaultPasteFn() {
  const { pasteClipboard } = await import("./paste.js");
  await pasteClipboard();
}

async function defaultActivateWindowFn(appName, windowTitle) {
  const { activateWindow } = await import("./windowManager.js");
  return activateWindow(appName, windowTitle);
}
