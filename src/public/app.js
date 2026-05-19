const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#resultText");
const recordButton = document.querySelector("#recordButton");
const autoPasteEl = document.querySelector("#autoPaste");
const fallbackButton = document.querySelector("#fallbackButton");
const fallbackFile = document.querySelector("#fallbackFile");

let recorder = null;
let chunks = [];
let isRecording = false;
let isStarting = false;
let stopRequested = false;
let maxRecordTimer = null;

connectWebSocket();

if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
  setStatus("当前浏览器无法直接录音，可改用音频上传兜底。", true);
  recordButton.disabled = true;
  fallbackButton.classList.remove("hidden");
}

recordButton.addEventListener("pointerdown", startRecording);
recordButton.addEventListener("pointerup", stopRecording);
recordButton.addEventListener("pointercancel", stopRecording);
recordButton.addEventListener("pointerleave", () => {
  if (isRecording) {
    stopRecording();
  }
});
fallbackButton.addEventListener("click", () => fallbackFile.click());
fallbackFile.addEventListener("change", async () => {
  const file = fallbackFile.files?.[0];
  if (file) {
    await uploadAudio(file, fileExtensionFor(file.type));
    fallbackFile.value = "";
  }
});

async function startRecording(event) {
  event.preventDefault();
  if (isRecording || isStarting) {
    return;
  }

  try {
    isStarting = true;
    stopRequested = false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    const mimeType = pickMimeType();
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

    recorder.addEventListener("dataavailable", (dataEvent) => {
      if (dataEvent.data.size > 0) {
        chunks.push(dataEvent.data);
      }
    });

    recorder.addEventListener("stop", async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      await uploadAudio(blob, fileExtensionFor(blob.type));
    });

    recorder.start();
    isStarting = false;
    isRecording = true;
    recordButton.classList.add("recording");
    recordButton.textContent = "松开结束";
    setStatus("正在录音...");
    maxRecordTimer = setTimeout(() => {
      if (isRecording) {
        stopRecording();
        setStatus("已到 55 秒上限，正在上传音频...");
      }
    }, 55_000);

    if (stopRequested) {
      stopRecording();
    }
  } catch (error) {
    isStarting = false;
    setStatus(`无法访问麦克风：${error.message}`, true);
  }
}

function stopRecording(event) {
  event?.preventDefault();
  if (isStarting) {
    stopRequested = true;
    return;
  }
  if (!isRecording || !recorder) {
    return;
  }

  isRecording = false;
  clearTimeout(maxRecordTimer);
  recordButton.classList.remove("recording");
  recordButton.textContent = "按住说话";
  setStatus("正在上传音频...");
  recorder.stop();
}

async function uploadAudio(blob, extension) {
  if (!blob.size) {
    setStatus("没有录到声音，请再试一次。", true);
    return;
  }

  const formData = new FormData();
  formData.append("audio", blob, `voicebridge.${extension}`);
  formData.append("autoPaste", String(autoPasteEl.checked));

  try {
    setStatus("正在识别...");
    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "上传失败");
    }

    resultEl.textContent = payload.text || "没有识别到文字";
    const output = payload.output || {};
    if (output.pasted) {
      setStatus("已复制并自动粘贴。");
    } else {
      setStatus("已复制到电脑剪切板。");
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/ws`);

  socket.addEventListener("open", () => setStatus("已连接电脑端。"));
  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "result" && payload.text) {
        resultEl.textContent = payload.text;
      }
      if (payload.message) {
        setStatus(payload.message, payload.type === "error");
      }
      if (payload.type === "output" && payload.copied && !payload.pasted) {
        setStatus(payload.pasteError ? "已复制，自动粘贴失败。" : "已复制到剪切板。", Boolean(payload.pasteError));
      }
    } catch {
      // Ignore malformed status messages from non-MVP clients.
    }
  });
  socket.addEventListener("close", () => {
    setStatus("连接已断开，正在重连...");
    setTimeout(connectWebSocket, 1500);
  });
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function fileExtensionFor(mimeType) {
  if (mimeType.includes("mp4")) {
    return "m4a";
  }
  if (mimeType.includes("mpeg")) {
    return "mp3";
  }
  return "webm";
}
