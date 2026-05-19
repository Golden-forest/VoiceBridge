import { WebSocket, WebSocketServer } from "ws";

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
