import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { runDesktopInputOperation } from "../../server/input/desktopInputQueue.js";

const source = (await readFile(new URL("./main.js", import.meta.url), "utf8"))
  .replace(/^import .+;\n/gm, "").replaceAll("import.meta.url", "'file:///app/src/agent/electron/main.js'");

function harness({ revokedRow = true } = {}) {
  const calls = [];
  const handlers = new Map();
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "runtime-1" } } } }),
      signOut: async () => calls.push("signOut")
    },
    from() {
      return { update() {
        const query = { eq: () => query, select: () => query,
          maybeSingle: async () => { calls.push("revokeDevice"); return { data: revokedRow ? { id: "desktop-1" } : null }; } };
        return query;
      } };
    }
  };
  const context = vm.createContext({
    app: { whenReady: () => ({ then() {} }), on() {}, getPath: () => "/tmp/voicebridge-test", getVersion: () => "test" },
    ipcMain: { handle(name, callback) { handlers.set(name, callback); } }, process: { env: {}, platform: "darwin" },
    clipboard: { writeText: (text) => calls.push(`clipboard:${text}`) }, runDesktopInputOperation,
    fileURLToPath: () => "/app/src/agent/electron/main.js", dirname, join,
    readFileSync: () => { throw new Error("no bundled config"); },
    rm: async () => calls.push("removeTokens"),
    loadOrCreateDevice: async () => ({ id: "desktop-1" }),
    clearTimeout() {}, setTimeout() {}, console, fakeClient: client, calls
  });
  vm.runInContext(source, context);
  vm.runInContext(`desktopClient = fakeClient;
    currentPlan = 'pro';
    activeAgent = { runtime: { stop: async () => calls.push('stopRealtime') } };
    lanServer = { close: async ({ revokeTokens }) => calls.push(revokeTokens ? 'revokeLan' : 'stopLan') };
    initializeDesktop = async () => ({ mode: 'pairing' });`, context);
  return { context, calls, handlers };
}

test("desktop unpair stops every input channel and revokes tokens before signing out", async () => {
  const { context, calls } = harness();
  const state = await vm.runInContext("unpairDesktop()", context);
  assert.equal(state.mode, "pairing");
  assert.deepEqual(calls, ["stopRealtime", "revokeLan", "revokeDevice", "signOut"]);
  assert.equal(vm.runInContext("currentPlan", context), null);
  assert.equal(vm.runInContext("lanServer", context), null);
  assert.equal(vm.runInContext("desktopGeneration", context), 1);
});

test("a denied device revoke keeps the session available for retry and never claims success", async () => {
  const { context, calls } = harness({ revokedRow: false });
  await assert.rejects(vm.runInContext("unpairDesktop()", context), /未能撤销电脑绑定/);
  assert.deepEqual(calls, ["stopRealtime", "revokeLan", "revokeDevice"]);
  assert.ok(vm.runInContext("desktopClient", context));
});

test("signed-out recovery also clears LAN authority and the cached plan", async () => {
  const { context, calls } = harness();
  await vm.runInContext("recoverAfterSignOut()", context);
  assert.deepEqual(calls, ["stopRealtime", "revokeLan"]);
  assert.equal(vm.runInContext("currentPlan", context), null);
});

test("a pairing poll returning after unpair cannot bring an old desktop session online", async () => {
  const { context, calls } = harness();
  let poll;
  let release;
  context.setTimeout = (callback) => { poll = callback; return 1; };
  context.pendingStatus = new Promise((resolve) => { release = resolve; });
  vm.runInContext(`fetchPairingStatus = () => pendingStatus;
    goOnline = async () => calls.push('online');
    schedulePairingPoll({ supabase: {}, device: { id: 'desktop-1' }, generation: 0 });`, context);
  const polling = poll();
  vm.runInContext("desktopGeneration++", context);
  release({ paired: true, user_id: "old-user", plan: "pro" });
  await polling;
  assert.deepEqual(calls, []);
});

test("Electron copy text waits for the shared desktop input transaction", async () => {
  const { calls, handlers } = harness();
  let release;
  let entered;
  const enteredQueue = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const operation = runDesktopInputOperation(async () => { entered(); await blocked; });
  await enteredQueue;
  const copy = handlers.get("voicebridge:copy-text")({}, "new text");
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, []);
    release();
    await operation;
    assert.equal((await copy).ok, true);
    assert.deepEqual(calls, ["clipboard:new text"]);
  } finally {
    release();
    await operation;
    await copy;
  }
});
