import { WebSocket, WebSocketServer } from "ws";
import { pressEnter, pressUndo, pressCtrlC, pressEscape, pressArrow, pasteClipboard } from "./input/paste.js";
import { outputText } from "./input/outputText.js";

export function createWebSocketHub(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set();

  wss.on("connection", (socket) => {
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
        if (payload.type === "enter") {
          await pressEnter();
        }
        if (payload.type === "undo") {
          await pressUndo();
        }
        if (payload.type === "ctrl-c") {
          await pressCtrlC();
        }
        if (payload.type === "escape") {
          await pressEscape();
          if (payload.twice) await pressEscape();
        }
        if (payload.type === "arrow" && payload.direction) {
          await pressArrow(payload.direction);
        }
        if (payload.type === "paste") {
          await pasteClipboard();
        }
        if (payload.type === "phrase" && typeof payload.text === "string") {
          const result = await outputText(payload.text, {
            autoPaste: Boolean(payload.autoPaste),
            targetWindow: payload.targetWindow || null
          });
          broadcast({ type: "output", ...result });
        }
      } catch {
        // Ignore malformed messages.
      }
    });
  });

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
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
