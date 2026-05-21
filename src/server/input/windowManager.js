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
    // Escape double quotes and backslashes to prevent AppleScript injection
    const safeAppName = appName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const safeWindowTitle = windowTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const script = `
tell application "System Events"
  set frontmost of process "${safeAppName}" to true
end tell
delay 0.1
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
