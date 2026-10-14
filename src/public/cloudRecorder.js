import { encodeWav16Mono } from "./wavEncoder.js";

export async function recordWavUntilStopped({ onStopReady, maxDurationMs, onMaxDurationReached, signal }) {
  let stream = null;
  let audioContext = null;
  let source = null;
  let processor = null;
  const chunks = [];
  let stopped = false;
  let totalSamples = 0;
  let autoStopTriggered = false;

  async function cancel() {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener("abort", cancel);
    if (processor) processor.onaudioprocess = null;
    safeDisconnect(processor);
    safeDisconnect(source);
    safeStopTracks(stream);
    chunks.length = 0;
    await safeCloseAudioContext(audioContext);
  }

  try {
    if (signal?.aborted) throw new DOMException("录音已取消", "AbortError");
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (signal?.aborted) throw new DOMException("录音已取消", "AbortError");
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    try {
      audioContext = new AudioContextCtor({ sampleRate: 16000 });
    } catch {
      audioContext = new AudioContextCtor();
    }
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      const channel = new Float32Array(event.inputBuffer.getChannelData(0));
      chunks.push(channel);
      totalSamples += channel.length;
      if (
        typeof maxDurationMs === "number" &&
        maxDurationMs > 0 &&
        !autoStopTriggered &&
        typeof onMaxDurationReached === "function" &&
        (totalSamples / audioContext.sampleRate) * 1000 >= maxDurationMs
      ) {
        autoStopTriggered = true;
        try {
          onMaxDurationReached();
        } catch (callbackError) {
          console.error("onMaxDurationReached threw:", callbackError);
        }
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    signal?.addEventListener("abort", cancel, { once: true });
  } catch (error) {
    if (processor) processor.onaudioprocess = null;
    safeDisconnect(processor);
    safeDisconnect(source);
    safeStopTracks(stream);
    await safeCloseAudioContext(audioContext);
    throw error;
  }

  return {
    cancel,
    async stop() {
      if (stopped) return;
      stopped = true;
      signal?.removeEventListener("abort", cancel);
      processor.onaudioprocess = null;
      safeDisconnect(processor);
      safeDisconnect(source);
      safeStopTracks(stream);
      try {
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const samples = new Float32Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          samples.set(chunk, offset);
          offset += chunk.length;
        }
        const blob = encodeWav16Mono(samples, audioContext.sampleRate);
        chunks.length = 0;
        const contextToClose = audioContext;
        audioContext = null;
        await safeCloseAudioContext(contextToClose);
        await onStopReady(blob);
      } finally {
        await safeCloseAudioContext(audioContext);
      }
    }
  };
}

function safeDisconnect(node) {
  try {
    node?.disconnect();
  } catch {
    // Already disconnected or unavailable.
  }
}

function safeStopTracks(stream) {
  try {
    stream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Ignore individual track cleanup failures.
      }
    });
  } catch {
    // Ignore malformed stream cleanup failures.
  }
}

async function safeCloseAudioContext(audioContext) {
  if (!audioContext || audioContext.state === "closed") return;
  try {
    await audioContext.close();
  } catch {
    // Cleanup best effort; preserve the primary recording error.
  }
}
