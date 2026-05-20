import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function getPasteCommand(platform = process.platform) {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", 'tell application "System Events" to keystroke "v" using command down']
    };
  }

  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
      ]
    };
  }

  return {
    command: "xdotool",
    args: ["key", "ctrl+v"]
  };
}

export async function pasteClipboard() {
  const { command, args } = getPasteCommand();
  await execFileAsync(command, args, { windowsHide: true });
}

export function getEnterCommand(platform = process.platform) {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", 'tell application "System Events" to keystroke return']
    };
  }

  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"
      ]
    };
  }

  return {
    command: "xdotool",
    args: ["key", "Return"]
  };
}

export async function pressEnter() {
  const { command, args } = getEnterCommand();
  await execFileAsync(command, args, { windowsHide: true });
}

export function getUndoCommand(platform = process.platform) {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", 'tell application "System Events" to keystroke "z" using command down']
    };
  }

  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        "[System.Windows.Forms.SendKeys]::SendWait('^z')"
      ]
    };
  }

  return {
    command: "xdotool",
    args: ["key", "ctrl+z"]
  };
}

export async function pressUndo() {
  const { command, args } = getUndoCommand();
  await execFileAsync(command, args, { windowsHide: true });
}
