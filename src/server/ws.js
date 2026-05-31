import { WebSocket, WebSocketServer } from "ws";
import { pressEnter, pressUndo, pressCtrlC, pressEscape, pressDelete, pressArrow, pasteClipboard } from "./input/paste.js";
import { outputText } from "./input/outputText.js";

const MAX_BUFFER_SIZE = 64 * 1024;

export function createWebSocketHub(server) {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1024 * 1024 });
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
        switch (payload.type) {
          case "enter":
            await pressEnter();
            break;
          case "undo":
            await pressUndo();
            break;
          case "ctrl-c":
            await pressCtrlC();
            break;
          case "escape":
            await pressEscape();
            if (payload.twice) await pressEscape();
            break;
          case "delete":
            await pressDelete();
            break;
          case "arrow": {
            const allowed = new Set(["up", "down", "left", "right"]);
            if (payload.direction && allowed.has(payload.direction)) {
              await pressArrow(payload.direction);
            }
            break;
          }
          case "paste":
            await pasteClipboard();
            break;
          case "phrase":
            if (typeof payload.text === "string" && payload.text.length <= 10000) {
              const result = await outputText(payload.text, {
                autoPaste: Boolean(payload.autoPaste),
                targetWindow: payload.targetWindow || null
              });
              if (socket.readyState === WebSocket.OPEN) broadcast({ type: "output", ...result });
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
