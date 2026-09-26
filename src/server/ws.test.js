import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";

import { createWebSocketHub } from "./ws.js";

function startHub({ keyHandlers, output, onAsrPrefetch } = {}) {
  const server = http.createServer();
  const hub = createWebSocketHub(server, {
    keyHandlers: keyHandlers || {
      "enter": async () => {},
      "paste": async () => { throw new Error("paste failed"); }
    },
    output: output || (async () => ({ copied: true, pasted: true })),
    onAsrPrefetch
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

test("asr-prefetch routes to the callback without any reply", async () => {
  const seen = [];
  const ctx = await startHub({ onAsrPrefetch: (durationMs) => seen.push(durationMs) });
  const client = connect(ctx.port);
  try {
    await client.opened;
    await client.next();

    client.socket.send(JSON.stringify({ type: "asr-prefetch", duration_ms: 60000 }));
    client.socket.send(JSON.stringify({ type: "asr-prefetch", duration_ms: -5 })); // 无效值忽略
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(seen, [60000]);
    assert.equal(client.messages.length, 1, "no reply for fire-and-forget prefetch");
  } finally {
    await closeAll({ ...ctx, sockets: [client.socket] });
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
