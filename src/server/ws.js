import { WebSocket, WebSocketServer } from "ws";
import { pressEnter, pressUndo, pressCtrlC, pressEscape, pressDelete, pressArrow, pasteClipboard } from "./input/paste.js";
import { outputText } from "./input/outputText.js";
import { isLoopbackRequest } from "./lanPairing.js";
import { MESSAGE_TYPES } from "../shared/protocol.js";

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
  onAsrPrefetch
} = {}) {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1024 * 1024 });
  const clients = new Set();

  wss.on("connection", (socket, req) => {
    if (authorize && !isLoopbackRequest(req) && !authorize(req)) {
      socket.close(4001, "unauthorized");
      return;
    }
    clients.add(socket);
    send(socket, {
      type: "status",
      status: "connected",
      message: "Connected to VoiceBridge"
    });

    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    socket.on("message", async (data) => {
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
              await handler();
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
              const result = await output(payload.text, {
                autoPaste: Boolean(payload.autoPaste),
                targetWindow: payload.targetWindow || null
              });
              if (socket.readyState === WebSocket.OPEN) broadcast({ type: "output", ...result });
            }
            break;
          // 录音开始即预取识别签名（LAN 延迟优化）：与录音并行做跨境签名往返，
          // 说完话上传音频时直接识别。fire-and-forget，不回复。
          case "asr-prefetch":
            if (Number.isFinite(payload.duration_ms) && payload.duration_ms > 0) {
              onAsrPrefetch?.(payload.duration_ms);
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
    wss.close();
  }

  return { broadcast, close, clients };
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}
