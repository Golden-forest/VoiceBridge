import { encodeWav16Mono } from "./wavEncoder.js";

export async function recordWavUntilStopped({ onStopReady }) {
  let stream = null;
  let audioContext = null;
  let source = null;
  let processor = null;
  const chunks = [];
  let stopped = false;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextCtor();
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
  } catch (error) {
    if (processor) processor.onaudioprocess = null;
    safeDisconnect(processor);
    safeDisconnect(source);
    safeStopTracks(stream);
    await safeCloseAudioContext(audioContext);
    throw error;
  }

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
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
