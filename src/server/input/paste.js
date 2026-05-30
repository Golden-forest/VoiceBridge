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

// --- Generic key press helper ---
const MAC_KEY_CODES = {
  escape: 53,
  delete: 51,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
};

function keyCommand(platform, key, modifiers = {}) {
  if (platform === "darwin") {
    const mod = Object.entries(modifiers)
      .map(([mod, on]) => on ? `${mod} down` : "")
      .filter(Boolean).join(" ");
    const using = mod ? ` using {${mod}}` : "";

    if (key in MAC_KEY_CODES) {
      return {
        command: "osascript",
        args: ["-e", `tell application "System Events" to key code ${MAC_KEY_CODES[key]}${using}`]
      };
    }

    return {
      command: "osascript",
      args: ["-e", `tell application "System Events" to keystroke "${key}"${using}`]
    };
  }
  if (platform === "win32") {
    let sendKey = key;
    if (modifiers.ctrl) sendKey = `^${sendKey}`;
    if (modifiers.alt) sendKey = `%${sendKey}`;
    if (modifiers.shift) sendKey = `+${sendKey}`;
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", `[System.Windows.Forms.SendKeys]::SendWait('${sendKey}')`]
    };
  }
  const parts = [];
  if (modifiers.ctrl) parts.push("ctrl");
  if (modifiers.alt) parts.push("alt");
  if (modifiers.shift) parts.push("shift");
  parts.push(key);
  return { command: "xdotool", args: ["key", parts.join("+")] };
}

export async function pressCtrlC() {
  const { command, args } = keyCommand(process.platform, "c", { ctrl: true });
  await execFileAsync(command, args, { windowsHide: true });
}

export async function pressEscape() {
  const { command, args } = keyCommand(process.platform, "escape");
  await execFileAsync(command, args, { windowsHide: true });
}

export async function pressDelete() {
  const { command, args } = keyCommand(process.platform, "delete");
  await execFileAsync(command, args, { windowsHide: true });
}

export async function pressArrow(direction) {
  const keyMap = { up: "up", down: "down", left: "left", right: "right" };
  const key = keyMap[direction] || direction;
  const { command, args } = keyCommand(process.platform, key);
  await execFileAsync(command, args, { windowsHide: true });
}
