export async function outputText(
  text,
  {
    autoPaste,
    pasteDelayMs = 120,
    clipboardWriter = defaultClipboardWriter,
    pasteFn = defaultPasteFn,
    logger = console
  } = {}
) {
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
