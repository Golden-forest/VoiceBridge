import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import net from "node:net";
import { once } from "node:events";

import { createWebSocketHub } from "./ws.js";
import { runDesktopInputOperation } from "./input/desktopInputQueue.js";

function startHub({ keyHandlers, output, authorize, trustOrigin, closeTimeoutMs, activateWindow } = {}) {
  const server = http.createServer();
  const hub = createWebSocketHub(server, {
    keyHandlers: keyHandlers || {
      "enter": async () => {},
      "paste": async () => { throw new Error("paste failed"); }
    },
    output: output || (async () => ({ copied: true, pasted: true })),
    authorize, trustOrigin, closeTimeoutMs, activateWindow
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, hub, port: server.address().port });
    });
  });
}

function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  let cursor = 0;
  const opened = new Promise((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  // 按序取下一条未消费的消息。连接 status 在 open 事件前就可能已入队，
  // 所以用游标而不是"等数组变长"。
  const next = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`message timeout (received: ${JSON.stringify(messages)})`)), 2000);
    const poll = () => {
      if (messages.length > cursor) {
        clearTimeout(timer);
        resolve(messages[cursor++]);
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
  return { socket, messages, opened, next };
}

async function closeAll({ server, hub, sockets }) {
  for (const socket of sockets || []) socket.terminate();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  hub.close();
}

test("key commands ack success to the sender socket", async () => {
  const ctx = await startHub();
  const client = connect(ctx.port);
  try {
    await client.opened;
    const status = await client.next();
    assert.equal(status.type, "status");

    client.socket.send(JSON.stringify({ type: "key", key: "enter" }));
    const ack = await client.next();
    assert.equal(ack.type, "ack");
    assert.equal(ack.key, "enter");
    assert.equal(ack.status, "success");
    assert.equal(ack.detail, "key:enter");
  } finally {
    await closeAll({ ...ctx, sockets: [client.socket] });
  }
});

test("a queued LAN key rechecks its token after another desktop operation finishes", async () => {
  let authorized = true;
  let checks = 0;
  let keyPresses = 0;
  let release;
  let entered;
  const enteredQueue = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const ctx = await startHub({ authorize: () => { checks++; return authorized; },
    keyHandlers: { enter: async () => { keyPresses++; } } });
  const client = connect(ctx.port);
  let blocker;
  try {
    await client.opened;
    await client.next();
    blocker = runDesktopInputOperation(async () => { entered(); await blocked; });
    await enteredQueue;
    client.socket.send(JSON.stringify({ type: "key", key: "enter" }));
    for (let tries = 0; checks < 2 && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(checks, 2, "the key was accepted before the permission changed");
    authorized = false;
    release();
    await blocker;
    const ack = await client.next();
    assert.equal(ack.status, "failed");
    assert.match(ack.detail, /已关闭/);
    assert.equal(keyPresses, 0);
  } finally {
    release();
    await blocker;
    await closeAll({ ...ctx, sockets: [client.socket] });
  }
});

test("hub closes a WebSocket that never acknowledges the close frame within a deadline", async () => {
  const ctx = await startHub({ closeTimeoutMs: 20 });
  const socket = net.connect(ctx.port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(`GET /ws HTTP/1.1\r\nHost: localhost:${ctx.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await once(socket, "data");
  assert.equal(ctx.hub.clients.size, 1);
  let timeout;
  try {
    await Promise.race([ctx.hub.close(), new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("close hung")), 1000);
    })]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(ctx.hub.clients.size, 0);
  socket.destroy();
  await new Promise((resolve) => ctx.server.close(resolve));
});

test("voice result phrases reuse command handling without a nested queue deadlock", async () => {
  const calls = [];
  const ctx = await startHub({ keyHandlers: { enter: async () => calls.push("enter"), delete: async () => calls.push("delete") },
    output: async (text) => { calls.push(text); return { copied: true, pasted: true }; } });
  const client = connect(ctx.port);
  try {
    await client.opened;
    await client.next();
    client.socket.send(JSON.stringify({ type: "phrase", text: "发送。", voiceCommand: true, autoPaste: true }));
    const result = await client.next();
    assert.equal(result.command, "send");
    assert.equal(result.keyPressed, true);
    assert.deepEqual(calls, ["enter"]);
  } finally {
    await closeAll({ ...ctx, sockets: [client.socket] });
  }
});

test("LAN key commands refuse a failed selected-window activation", async () => {
  let pressed = false;
  const ctx = await startHub({ keyHandlers: { enter: async () => { pressed = true; } },
    activateWindow: async () => ({ success: false, error: "window closed" }) });
  const client = connect(ctx.port);
  try {
    await client.opened;
    await client.next();
    client.socket.send(JSON.stringify({ type: "key", key: "enter", targetWindow: { appName: "Notes", windowTitle: "Gone" } }));
    const ack = await client.next();
    assert.equal(ack.status, "failed");
    assert.equal(ack.detail, "window closed");
    assert.equal(pressed, false);
  } finally {
    await closeAll({ ...ctx, sockets: [client.socket] });
  }
});

test("key commands ack failed with detail when the handler throws", async () => {
  const ctx = await startHub();
  const client = connect(ctx.port);
  try {
    await client.opened;
    await client.next();

    client.socket.send(JSON.stringify({ type: "key", key: "paste" }));
    const ack = await client.next();
    assert.equal(ack.type, "ack");
    assert.equal(ack.key, "paste");
    assert.equal(ack.status, "failed");
    assert.match(ack.detail, /paste failed/);
  } finally {
    await closeAll({ ...ctx, sockets: [client.socket] });
  }
});

test("unknown keys get a failed ack instead of silence", async () => {
  const ctx = await startHub();
  const client = connect(ctx.port);
  try {
    await client.opened;
    await client.next();

    client.socket.send(JSON.stringify({ type: "key", key: "sing-a-song" }));
    const ack = await client.next();
    assert.equal(ack.type, "ack");
    assert.equal(ack.key, "sing-a-song");
    assert.equal(ack.status, "failed");
    assert.equal(ack.detail, "unknown_key");
  } finally {
    await closeAll({ ...ctx, sockets: [client.socket] });
  }
});

test("key acks go only to the sender, not other clients", async () => {
  const ctx = await startHub();
  const sender = connect(ctx.port);
  const other = connect(ctx.port);
  try {
    await Promise.all([sender.opened, other.opened]);
    await sender.next();
    await other.next();

    sender.socket.send(JSON.stringify({ type: "key", key: "enter" }));
    const ack = await sender.next();
    assert.equal(ack.status, "success");

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(other.messages.length, 1, "other client only saw its connection status");
  } finally {
    await closeAll({ ...ctx, sockets: [sender.socket, other.socket] });
  }
});

test("phrase output is still broadcast to every client", async () => {
  const ctx = await startHub({ output: async () => ({ copied: true, pasted: true, text: "hi" }) });
  const sender = connect(ctx.port);
  const other = connect(ctx.port);
  try {
    await Promise.all([sender.opened, other.opened]);
    await sender.next();
    await other.next();

    sender.socket.send(JSON.stringify({ type: "phrase", text: "hi", autoPaste: true }));
    const output = await sender.next();
    assert.equal(output.type, "output");
    assert.equal(output.pasted, true);
    const otherOutput = await other.next();
    assert.equal(otherOutput.type, "output");
  } finally {
    await closeAll({ ...ctx, sockets: [sender.socket, other.socket] });
  }
});

test("a phrase rejected by the input channel returns an error frame to the sender", async () => {
  let authorized = true;
  const ctx = await startHub({ authorize: () => authorized, output: async () => ({ copied: true, pasted: true }) });
  const sender = connect(ctx.port);
  try {
    await sender.opened;
    await sender.next();
    // 手机端撤销配对 token 的瞬间：socket 仍开着，但请求已不再有效。
    authorized = false;
    sender.socket.send(JSON.stringify({ type: "phrase", text: "hi", autoPaste: false }));
    const frame = await sender.next();
    assert.equal(frame.type, "error", "the phone must learn its optimistic toast was wrong");
    assert.match(frame.message, /配对已被撤销/);
  } finally {
    await closeAll({ ...ctx, sockets: [sender.socket] });
  }
});
