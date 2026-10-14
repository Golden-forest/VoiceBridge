import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { recordWavUntilStopped } from "./cloudRecorder.js";

const appSource = await readFile(new URL("./app.js", import.meta.url), "utf8");

test("cloud and LAN modes share the direct WAV recorder path", () => {
  assert.match(appSource, /recordWavUntilStopped/);
  assert.match(appSource, /onStopReady:\s*async \(blob\) => uploadAudio\(blob, "wav", context\)/);
  assert.doesNotMatch(appSource, /new MediaRecorder/);
});

test("recordWavUntilStopped cleans up media resources when setup fails", async () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const track = createTrack();
  const stream = { getTracks: () => [track] };
  const context = createAudioContext({
    createScriptProcessor() {
      throw new Error("processor failed");
    }
  });

  setBrowserGlobals({ stream, context });

  try {
    await assert.rejects(
      () => recordWavUntilStopped({ onStopReady: async () => {} }),
      /processor failed/
    );
    assert.equal(track.stopCount, 1);
    assert.equal(context.source.disconnectCount, 1);
    assert.equal(context.closeCount, 1);
  } finally {
    restoreBrowserGlobals(originalNavigator, originalWindow);
  }
});

test("recordWavUntilStopped stop is idempotent and clears audio processing", async () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const track = createTrack();
  const stream = { getTracks: () => [track] };
  const context = createAudioContext();
  const uploaded = [];

  setBrowserGlobals({ stream, context });

  try {
    const recorder = await recordWavUntilStopped({
      onStopReady: async (blob) => uploaded.push(blob)
    });

    context.processor.onaudioprocess({
      inputBuffer: {
        getChannelData: () => new Float32Array([0, 0.5, -0.5])
      }
    });

    await recorder.stop();
    await recorder.stop();

    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].type, "audio/wav");
    assert.equal(context.processor.onaudioprocess, null);
    assert.equal(context.processor.disconnectCount, 1);
    assert.equal(context.source.disconnectCount, 1);
    assert.equal(track.stopCount, 1);
    assert.equal(context.closeCount, 1);
  } finally {
    restoreBrowserGlobals(originalNavigator, originalWindow);
  }
});

test("recordWavUntilStopped closes audio context when upload callback rejects", async () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const track = createTrack();
  const stream = { getTracks: () => [track] };
  const context = createAudioContext();

  setBrowserGlobals({ stream, context });

  try {
    const recorder = await recordWavUntilStopped({
      onStopReady: async () => {
        throw new Error("upload failed");
      }
    });

    await assert.rejects(() => recorder.stop(), /upload failed/);
    assert.equal(context.closeCount, 1);
    assert.equal(track.stopCount, 1);
  } finally {
    restoreBrowserGlobals(originalNavigator, originalWindow);
  }
});

test("recordWavUntilStopped requests a native 16 kHz AudioContext", async () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const track = createTrack();
  const stream = { getTracks: () => [track] };
  const context = createAudioContext();
  let requestedOptions;

  setBrowserGlobals({
    stream,
    context,
    onConstruct: (options) => { requestedOptions = options; }
  });

  try {
    const recorder = await recordWavUntilStopped({ onStopReady: async () => {} });
    await recorder.stop();
    assert.deepEqual(requestedOptions, { sampleRate: 16000 });
  } finally {
    restoreBrowserGlobals(originalNavigator, originalWindow);
  }
});

function createTrack() {
  return {
    stopCount: 0,
    stop() {
      this.stopCount++;
    }
  };
}

function createAudioContext(overrides = {}) {
  const source = createNode();
  const processor = createNode();
  processor.onaudioprocess = null;
  return {
    sampleRate: 16000,
    source,
    processor,
    destination: {},
    closeCount: 0,
    createMediaStreamSource: overrides.createMediaStreamSource || (() => source),
    createScriptProcessor: overrides.createScriptProcessor || (() => processor),
    async close() {
      this.closeCount++;
    }
  };
}

function createNode() {
  return {
    connectCount: 0,
    disconnectCount: 0,
    connect() {
      this.connectCount++;
    },
    disconnect() {
      this.disconnectCount++;
    }
  };
}

function setBrowserGlobals({ stream, context, onConstruct = () => {} }) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia() {
          return stream;
        }
      }
    }
  });
  globalThis.window = {
    AudioContext: function AudioContext(options) {
      onConstruct(options);
      return context;
    }
  };
}

function restoreBrowserGlobals(originalNavigator, originalWindow) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: originalNavigator
  });
  globalThis.window = originalWindow;
}

test("cancel while microphone permission is pending releases the late stream without creating an audio context", async () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const track = createTrack();
  const context = createAudioContext();
  let resolvePermission;
  let contextsCreated = 0;
  setBrowserGlobals({ stream: { getTracks: () => [track] }, context, onConstruct: () => contextsCreated++ });
  navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => { resolvePermission = resolve; });
  const controller = new AbortController();
  try {
    const pending = recordWavUntilStopped({ signal: controller.signal, onStopReady: async () => assert.fail("cancelled recording must not upload") });
    controller.abort();
    resolvePermission({ getTracks: () => [track] });
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(track.stopCount, 1);
    assert.equal(contextsCreated, 0);
  } finally { restoreBrowserGlobals(originalNavigator, originalWindow); }
});

test("identity cancellation stops an active recorder without uploading", async () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const track = createTrack();
  const context = createAudioContext();
  const controller = new AbortController();
  setBrowserGlobals({ stream: { getTracks: () => [track] }, context });
  try {
    const recorder = await recordWavUntilStopped({ signal: controller.signal, onStopReady: async () => assert.fail("cancel must not upload") });
    controller.abort();
    await recorder.cancel();
    await recorder.stop();
    assert.equal(track.stopCount, 1);
    assert.equal(context.closeCount, 1);
    assert.equal(context.processor.onaudioprocess, null);
  } finally { restoreBrowserGlobals(originalNavigator, originalWindow); }
});

test("microphone and audio context close before waiting for network upload", async () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const track = createTrack();
  const context = createAudioContext();
  let completeUpload;
  setBrowserGlobals({ stream: { getTracks: () => [track] }, context });
  try {
    const recorder = await recordWavUntilStopped({ onStopReady: () => new Promise((resolve) => { completeUpload = resolve; }) });
    const pending = recorder.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(track.stopCount, 1);
    assert.equal(context.closeCount, 1);
    completeUpload();
    await pending;
    assert.equal(context.closeCount, 1);
  } finally { restoreBrowserGlobals(originalNavigator, originalWindow); }
});
