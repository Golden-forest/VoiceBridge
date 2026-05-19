import clipboardy from "clipboardy";

export async function writeClipboard(text) {
  await clipboardy.write(text);
}
