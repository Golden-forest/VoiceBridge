import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const APPLE_SCRIPT_LIST = `
tell application "System Events"
  set output to "{"
  set appList to name of every process whose visible is true
  set appCount to count of appList
  repeat with i from 1 to appCount
    set appName to item i of appList
    try
      tell process appName
        set winNames to name of every window
        if (count of winNames) > 0 then
          if output ≠ "{" then set output to output & ", "
          set escapedApp to my replaceChars(appName)
          set output to output & "\"" & escapedApp & "\": ["
          repeat with j from 1 to count of winNames
            if j > 1 then set output to output & ", "
            set escapedWin to my replaceChars(item j of winNames)
            set output to output & "\"" & escapedWin & "\""
          end repeat
          set output to output & "]"
        end if
      end tell
    end try
  end repeat
  set output to output & "}"
end tell
return output

on replaceChars(txt)
  set txt to my replaceStr(txt, "\\", "\\\\")
  set txt to my replaceStr(txt, "\"", "\\\"")
  return txt
end replaceChars

on replaceStr(txt, old, newStr)
  set tid to AppleScript's text item delimiters
  set AppleScript's text item delimiters to old
  set txtItems to text items of txt
  set AppleScript's text item delimiters to newStr
  set txt to txtItems as text
  set AppleScript's text item delimiters to tid
  return txt
end replaceStr
`.trim();

export async function listWindows({ execFileAsync: execAsync = execFileAsync, platform = process.platform } = {}) {
  if (platform !== "darwin") {
    return [];
  }

  try {
    const { stdout } = await execAsync("osascript", ["-e", APPLE_SCRIPT_LIST], {
      timeout: 3000,
      windowsHide: true
    });

    const parsed = JSON.parse(stdout.trim());
    const SKIP_APPS = ["VoiceBridge"];

    return Object.entries(parsed)
      .filter(([appName, windows]) => {
        if (!SKIP_APPS.some((skip) => appName.includes(skip))) return true;
        return false;
      })
      .filter(([, windows]) => windows && windows.length > 0)
      .map(([appName, windows]) => ({
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
