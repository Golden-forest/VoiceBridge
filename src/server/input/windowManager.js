import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const APPLE_SCRIPT_LIST = `tell application "System Events"
	set appList to name of every process whose visible is true
	set appCount to count of appList
	repeat with i from 1 to appCount
		set appName to item i of appList
		try
			tell process appName
				set winNames to name of every window
				repeat with j from 1 to count of winNames
					log appName & "\\t" & item j of winNames
				end repeat
			end tell
		end try
	end repeat
end tell`.trim();

const APPLE_SCRIPT_LIST_CLOUD = `tell application "System Events"
	set appList to every process whose visible is true
	repeat with appProcess in appList
		set appName to name of appProcess
		set appIsFrontmost to frontmost of appProcess
		try
			tell appProcess
				set winNames to name of every window
				repeat with j from 1 to count of winNames
					log appName & "\\t" & j & "\\t" & appIsFrontmost & "\\t" & item j of winNames
				end repeat
			end tell
		end try
	end repeat
end tell`.trim();

export function encodeCloudWindowId(appName, windowIndex) {
  return Buffer.from(JSON.stringify([appName, windowIndex]), "utf8").toString("base64url");
}

export function decodeCloudWindowId(windowId) {
  try {
    const [appName, windowIndex] = JSON.parse(Buffer.from(windowId, "base64url").toString("utf8"));
    if (typeof appName !== "string" || !appName || !Number.isInteger(windowIndex) || windowIndex < 1) {
      return null;
    }
    return { appName, windowIndex };
  } catch {
    return null;
  }
}

export async function listCloudWindows({
  includeTitles = false,
  execFileAsync: execAsync = execFileAsync,
  platform = process.platform
} = {}) {
  if (platform !== "darwin") return [];

  try {
    const { stderr } = await execAsync("osascript", ["-e", APPLE_SCRIPT_LIST_CLOUD], {
      timeout: 3000,
      windowsHide: true
    });
    const windows = [];
    for (const line of stderr.split("\n")) {
      const [rawAppName, rawIndex, rawFrontmost, ...rawTitle] = line.split("\t");
      const appName = rawAppName?.trim();
      const windowIndex = Number.parseInt(rawIndex, 10);
      if (!appName || !Number.isInteger(windowIndex) || appName.includes("VoiceBridge")) continue;
      const entry = {
        windowId: encodeCloudWindowId(appName, windowIndex),
        app: appName,
        active: rawFrontmost?.trim() === "true" && windowIndex === 1
      };
      if (includeTitles) entry.title = rawTitle.join("\t").trim();
      windows.push(entry);
    }
    windows.sort((a, b) => Number(b.active) - Number(a.active));
    return windows.slice(0, 10);
  } catch {
    return [];
  }
}

export async function activateCloudWindow(
  windowId,
  { execFileAsync: execAsync = execFileAsync, platform = process.platform, logger = console } = {}
) {
  if (platform !== "darwin") return { success: false, error: "Only supported on macOS" };
  const target = decodeCloudWindowId(windowId);
  if (!target) return { success: false, error: "Invalid window id" };

  const safeAppName = target.appName
    .replace(/[\r\n]/g, "")
    .slice(0, 200)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  const script = `tell application "System Events"
  tell process "${safeAppName}"
    set frontmost to true
    perform action "AXRaise" of window ${target.windowIndex}
  end tell
end tell`.trim();
  try {
    await execAsync("osascript", ["-e", script], {
      timeout: 3000,
      windowsHide: true
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`activateCloudWindow failed: ${message}`);
    return { success: false, error: message };
  }
}

export async function listWindows({ execFileAsync: execAsync = execFileAsync, platform = process.platform } = {}) {
  if (platform !== "darwin") {
    return [];
  }

  try {
    const { stderr } = await execAsync("osascript", ["-e", APPLE_SCRIPT_LIST], {
      timeout: 3000,
      windowsHide: true
    });

    // osascript log output goes to stderr, format: "appName: \\twindowTitle"
    const lines = stderr.split("\n").filter((l) => l.includes("\t"));
    const SKIP_APPS = ["VoiceBridge"];

    const grouped = new Map();
    for (const line of lines) {
      const sep = line.indexOf("\t");
      if (sep === -1) continue;
      const appName = line.slice(0, sep).trim();
      const winTitle = line.slice(sep + 1).trim();
      if (SKIP_APPS.some((skip) => appName.includes(skip))) continue;
      if (!winTitle) continue;
      if (!grouped.has(appName)) grouped.set(appName, []);
      grouped.get(appName).push(winTitle);
    }

    return Array.from(grouped.entries()).map(([appName, windows]) => ({
      appName,
      windows: windows.map((title, index) => ({ title, index: index + 1 }))
    }));
  } catch {
    return [];
  }
}

export async function activateWindow(appName, windowTitle, { execFileAsync: execAsync = execFileAsync, platform = process.platform, logger = console } = {}) {
  if (platform !== "darwin") {
    return { success: false, error: "Only supported on macOS" };
  }

  try {
    // Sanitize: strip newlines, truncate, escape to prevent AppleScript injection
    const cleanAppName = appName.replace(/[\r\n]/g, "").slice(0, 200);
    const cleanWindowTitle = windowTitle.replace(/[\r\n]/g, "").slice(0, 200);
    const safeAppName = cleanAppName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const safeWindowTitle = cleanWindowTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const script = `
tell application "System Events"
  set frontmost of process "${safeAppName}" to true
end tell
delay 0.02
tell application "${safeAppName}"
  activate
  set index of window "${safeWindowTitle}" to 1
end tell
`.trim();

    await execAsync("osascript", ["-e", script], {
      timeout: 3000,
      windowsHide: true
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`activateWindow failed: ${message}`);
    return { success: false, error: message };
  }
}
