import test from "node:test";
import assert from "node:assert/strict";

import { getPasteCommand } from "./paste.js";

test("getPasteCommand uses Cmd+V on macOS", () => {
  const command = getPasteCommand("darwin");

  assert.equal(command.command, "osascript");
  assert.ok(command.args.join(" ").includes("command down"));
});

test("getPasteCommand uses Ctrl+V on Windows and Linux", () => {
  const win = getPasteCommand("win32");
  const linux = getPasteCommand("linux");

  assert.equal(win.command, "powershell.exe");
  assert.ok(win.args.join(" ").includes("^v"));
  assert.equal(linux.command, "xdotool");
  assert.deepEqual(linux.args, ["key", "ctrl+v"]);
});
