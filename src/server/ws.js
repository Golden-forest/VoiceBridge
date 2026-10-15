import { WebSocket, WebSocketServer } from "ws";
import { pressEnter, pressUndo, pressCtrlC, pressEscape, pressDelete, pressArrow, pasteClipboard } from "./input/paste.js";
import { outputText } from "./input/outputText.js";
import { MESSAGE_TYPES } from "../shared/protocol.js";
import { runDesktopInputOperation } from "./input/desktopInputQueue.js";
import { createAsrTextOutputBuffer } from "./input/asrTextOutputBuffer.js";
import { activateWindow as activateDesktopWindow } from "./input/windowManager.js";

const MAX_BUFFER_SIZE = 64 * 1024;

// 默认按键动作（可注入替换，测试用）。
export const DEFAULT_KEY_HANDLERS = Object.freeze({
  "enter": pressEnter,
  "undo": pressUndo,
  "ctrl-c": pressCtrlC,
  "escape": pressEscape,
  "delete": pressDelete,
  "paste": pasteClipboard,
  "arrow-up": () => pressArrow("up"),
  "arrow-down": () => pressArrow("down"),
  "arrow-left": () => pressArrow("left"),
  "arrow-right": () => pressArrow("right")
});

export function createWebSocketHub(server, {
  authorize,
  keyHandlers = DEFAULT_KEY_HANDLERS,
  output = outputText,
  trustOrigin = () => true,
  closeTimeoutMs = 500,
  activateWindow = activateDesktopWindow
} = {}) {
  let closing = false;
  let closePromise = null;
  const wss = new WebSocketServer({
    server, path: "/ws", maxPayload: 1024 * 1024,
    verifyClient: ({ req }, done) => {
      if (closing || !trustOrigin(req)) return done(false, 403, "Forbidden");
      if (authorize && !authorize(req)) return done(false, 401, "Unauthorized");
      done(true);
    }
  });
  const clients = new Set();
  const requests = new WeakMap();
  const voiceOutput = createAsrTextOutputBuffer({
    outputTextFn: output,
    pressEnterFn: keyHandlers.enter,
    pressDeleteFn: keyHandlers.delete,
    isActive: () => !closing,
    activateWindowFn: activateWindow,
    onFlush: ({ text, output: result }) => broadcast({ type: "output", text, ...result, buffered: false })
  });

  wss.on("connection", (socket, req) => {
    clients.add(socket);
    requests.set(socket, req);
    send(socket, {
      type: "status",
      status: "connected",
      message: "Connected to VoiceBridge"
    });

    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    const requestIsActive = () => !closing && socket.readyState === WebSocket.OPEN &&
      (!authorize || authorize(req));
    socket.on("message", async (data) => {
      if (closing) {
        // 手机端发 phrase 前已弹乐观成功 toast：静默丢弃会让用户误以为已输入。
        send(socket, { type: "error", message: "电脑输入通道已关闭。" });
        return;
      }
      if (authorize && !authorize(req)) {
        // 先回错误帧再关连接：让手机把乐观成功 toast 纠正为失败提示。
        send(socket, { type: "error", message: "本设备的配对已被撤销，请重新配对。" });
        socket.close(4001, "unauthorized");
        return;
      }
      try {
        const payload = JSON.parse(data);
        switch (payload.type) {
          case MESSAGE_TYPES.KEY: {
            // 按键回执（只回请求方）：手机端凭它给成功/失败触感反馈。
            // send() 自带 readyState 防护，执行期间连接断开只是无回执，不报错。
            const handler = keyHandlers[payload.key];
            if (typeof handler !== "function") {
              send(socket, { type: "ack", key: payload.key, status: "failed", detail: "unknown_key" });
              break;
            }
            try {
              await runDesktopInputOperation(async () => {
                if (!requestIsActive()) throw new Error("电脑输入通道已关闭。");
                if (payload.targetWindow?.appName) {
                  const result = await activateWindow(payload.targetWindow.appName, payload.targetWindow.windowTitle);
                  if (result?.success === false) throw new Error(result.error || "无法激活目标窗口");
                  if (!requestIsActive()) throw new Error("电脑输入通道已关闭。");
                }
                return handler();
              });
              send(socket, { type: "ack", key: payload.key, status: "success", detail: `key:${payload.key}` });
            } catch (error) {
              send(socket, {
                type: "ack",
                key: payload.key,
                status: "failed",
                detail: error instanceof Error ? error.message : String(error)
              });
            }
            break;
          }
          case "phrase":
            if (typeof payload.text === "string" && payload.text.length <= 10000) {
              let result;
              try {
                result = await runDesktopInputOperation(() => {
                  if (!requestIsActive()) throw new Error("电脑输入通道已关闭。");
                  const options = {
                    autoPaste: Boolean(payload.autoPaste),
                    targetWindow: payload.targetWindow || null,
                    sourceIdentity: socket,
                    isActive: requestIsActive
                  };
                  if (payload.voiceCommand === true) {
                    return voiceOutput.handleText(payload.text, { ...options, immediate: true });
                  }
                  return output(payload.text, options);
                });
              } catch (error) {
                // 手机端发 phrase 前已弹过乐观成功 toast：失败必须回帧，
                // 否则用户以为文字已输入而实际什么都没发生。
                send(socket, {
                  type: "error",
                  message: error instanceof Error ? error.message : String(error)
                });
                break;
              }
              if (socket.readyState === WebSocket.OPEN && !result.flushed) {
                broadcast({ type: "output", ...(result.output ? { ...result.output,
                  command: result.command, keyPressed: result.keyPressed, keyError: result.keyError
                } : result) });
              }
            }
            break;
          default:
            console.warn("Unknown WebSocket message type:", payload.type);
        }
      } catch (err) {
        console.error("WebSocket message error:", err);
      }
    });
  });

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    const toRemove = [];
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) {
        toRemove.push(client);
        continue;
      }
      if (client.bufferedAmount > MAX_BUFFER_SIZE) {
        client.terminate();
        toRemove.push(client);
        continue;
      }
      client.send(data);
    }
    for (const client of toRemove) {
      clients.delete(client);
    }
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    voiceOutput.clear();
    closePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const socket of wss.clients) socket.terminate();
      }, closeTimeoutMs);
      for (const socket of wss.clients) socket.close(1001, "server shutting down");
      wss.close(() => {
        clearTimeout(timer);
        clients.clear();
        resolve();
      });
    });
    return closePromise;
  }

  function revalidateClients() {
    if (!authorize) return;
    for (const socket of clients) {
      if (!authorize(requests.get(socket))) socket.close(4001, "unauthorized");
    }
  }

  return { broadcast, close, clients, revalidateClients };
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}
