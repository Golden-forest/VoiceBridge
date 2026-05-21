# Window Selector Feature Design

## Problem

Users often have multiple windows open that need text input (chat, editor, browser, etc.). Currently, VoiceBridge pastes text to whatever the cursor is focused on, requiring the user to manually switch windows on the computer before sending text. This breaks the "remote from phone" workflow — the whole point is to not touch the computer.

## Solution

Add a window selector to the web UI that lists all visible, text-capable windows on the computer. The user can pick a target window from their phone, and VoiceBridge will automatically switch to that window before pasting.

## Requirements

1. List all visible application windows grouped by app, with window titles
2. Allow selecting a target window from the phone UI
3. When sending text (voice recognition, quick commands, saved phrases), automatically activate the selected window before pasting
4. Default behavior unchanged — no window selected means paste at current cursor position
5. Window selection persists in localStorage across page refreshes
6. macOS only; hide the feature on other platforms

## Architecture

### Data Flow

```
User opens panel → GET /api/windows → AppleScript enumerates windows → JSON response
User selects window → stored in client state + localStorage
User sends text → WebSocket phrase carries targetWindow field
  → Server: activateWindow(appName, windowTitle) → wait 200ms → clipboard + paste
No window selected → existing flow unchanged (paste at cursor)
```

### Server-side

**New file: `src/server/input/windowManager.js`**

Two functions:

1. `listWindows()` — enumerate visible windows
   - Uses `osascript` to iterate all visible processes and get their window names
   - Returns: `[{ appName: "Chrome", windows: [{ title: "GitHub - PR", index: 1 }] }]`
   - Filters out processes with no windows and VoiceBridge itself
   - 3-second timeout; returns empty array on failure

2. `activateWindow(appName, windowTitle)` — bring a specific window to front
   - `tell application "System Events" to set frontmost of process to true`
   - `perform action "AXRaise" of window`
   - Returns `{ success: boolean, error?: string }`
   - On failure, silently falls back to current cursor position

**New route: `GET /api/windows`** (registered in `index.js`)
- Calls `listWindows()`, returns JSON array

**Modified: `src/server/input/outputText.js`**
- New optional parameter `targetWindow: { appName, windowTitle }`
- If provided, calls `activateWindow()` → waits 200ms → clipboard → paste
- If not provided, existing logic unchanged

**Modified: `src/server/ws.js`**
- `phrase` message handler reads optional `targetWindow` field
- Passes it to `outputText(text, { autoPaste, targetWindow })`

**Modified: `src/server/routes/upload.js`**
- Accepts optional `targetAppName` + `targetWindowTitle` form fields
- Passes them to `outputText()` for voice recognition results

### Client-side UI

**Placement: top-left corner button**

```
┌──────────────────────────────────┐
│ [🪟 VS Code]  语音输入   🟢 已连接 │
│                                  │
│  (button expands dropdown panel) │
└──────────────────────────────────┘
```

**Dropdown panel content:**

```
┌──────────────────────┐
│ Chrome               │
│   · GitHub - PR      │
│   · ChatGPT          │
│ ▸ VS Code            │  ← selected, checkmark
│   · VoiceBridge 项目  │
│ 微信                  │
│   · 文件传输助手      │
│         🔄 刷新       │
└──────────────────────┘
```

**Button states:**
- No selection: shows "🪟 光标位置"
- Window selected: shows "🪟 {appName}"
- Loading: shows spinner

**Interaction:**
- Click button → toggle dropdown open/close
- Click window item → select it, close dropdown
- Click already-selected item → deselect, close dropdown
- Click outside dropdown → close it
- Dropdown opens → auto-fetch window list via GET /api/windows

**HTML changes in `index.html`:**
- Add window selector button in the header area (before the title)
- Add dropdown panel element

**JS changes in `app.js`:**
- Window selector logic: fetch, render, select, localStorage persistence
- When sending phrase/quick command: include `targetWindow` in WebSocket message
- When uploading audio: include `targetAppName` + `targetWindowTitle` in form data

**CSS changes in `style.css`:**
- Dropdown panel positioning and styling
- Dark mode support
- Mobile-friendly touch targets

### Error Handling

| Scenario | Behavior |
|---|---|
| AppleScript timeout (>3s) | Show "获取窗口失败，点击重试" in panel |
| Accessibility permission denied | Show guidance to grant permission in System Settings |
| Target window closed since selection | Auto-fallback to current cursor, status bar shows "目标窗口已关闭" |
| Non-macOS platform | Hide window selector button entirely |
| Window activation failure | Silent fallback to current cursor position |

### Testing

- Unit test `windowManager.listWindows()` — mock osascript output
- Unit test `windowManager.activateWindow()` — mock osascript, test success/failure
- Unit test `outputText.js` with `targetWindow` parameter — test activation + paste flow
- Unit test `outputText.js` without `targetWindow` — verify existing behavior unchanged
- All existing 14 tests continue to pass

## Out of Scope

- Browser tab-level targeting (too unreliable across browsers)
- Keyboard shortcut to switch windows from the phone
- Window history or favorites
- Multi-window selection (sending to multiple windows simultaneously)
