const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#resultText");
const recordButton = document.querySelector("#recordButton");
const enterButton = document.querySelector("#enterButton");
const undoButton = document.querySelector("#undoButton");
const autoPasteEl = document.querySelector("#autoPaste");
const fallbackButton = document.querySelector("#fallbackButton");
const fallbackFile = document.querySelector("#fallbackFile");

const iconEl = recordButton.querySelector(".record-icon");
const labelEl = recordButton.querySelector(".record-label");
const subEl = recordButton.querySelector(".record-sub");

const micSvg = '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const stopSvg = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

let recorder = null;
let chunks = [];
let isRecording = false;
let maxRecordTimer = null;
let timerInterval = null;
let recordSeconds = 0;
let isUploading = false;

let ws = null;

connectWebSocket();

function setActionButtonsDisabled(disabled) {
  enterButton.disabled = disabled;
  undoButton.disabled = disabled;
}

enterButton.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "enter" }));
  }
});

undoButton.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "undo" }));
  }
});

if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
  setStatus("当前浏览器无法直接录音，可改用音频上传兜底。", true);
  recordButton.disabled = true;
  fallbackButton.classList.remove("hidden");
}

recordButton.addEventListener("click", toggleRecording);

fallbackButton.addEventListener("click", () => fallbackFile.click());
fallbackFile.addEventListener("change", async () => {
  const file = fallbackFile.files?.[0];
  if (file) {
    await uploadAudio(file, fileExtensionFor(file.type));
    fallbackFile.value = "";
  }
});

async function toggleRecording() {
  if (isUploading) return;

  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

function setRecordIdle() {
  iconEl.className = "record-icon record-icon-mic";
  iconEl.innerHTML = micSvg;
  labelEl.textContent = "点击录音";
  subEl.textContent = "再次点击停止并发送";
}

function setRecordActive() {
  iconEl.className = "record-icon record-icon-stop";
  iconEl.innerHTML = stopSvg;
  labelEl.textContent = "停止录音";
  subEl.textContent = "点击结束并发送";
}

function setRecordProcessing() {
  iconEl.className = "record-icon record-icon-mic";
  iconEl.innerHTML = micSvg;
  labelEl.textContent = "处理中…";
  subEl.textContent = "";
}

async function startRecording() {
  try {
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
    isRecording = true;
    recordSeconds = 0;
    recordButton.classList.add("recording");
    setRecordActive();
    setActionButtonsDisabled(true);
    setStatus("正在录音…");

    maxRecordTimer = setTimeout(() => {
      if (isRecording) {
        stopRecording();
        setStatus("已到 55 秒上限，正在上传音频...");
      }
    }, 55_000);

    timerInterval = setInterval(() => {
      recordSeconds++;
      const mins = String(Math.floor(recordSeconds / 60)).padStart(2, "0");
      const secs = String(recordSeconds % 60).padStart(2, "0");
      subEl.textContent = `${mins}:${secs}`;
    }, 1000);
  } catch (error) {
    setStatus(`无法访问麦克风：${error.message}`, true);
  }
}

function stopRecording() {
  if (!isRecording || !recorder) return;

  isRecording = false;
  isUploading = true;
  clearTimeout(maxRecordTimer);
  clearInterval(timerInterval);
  recordButton.classList.remove("recording");
  recordButton.disabled = true;
  setRecordProcessing();
  setStatus("正在上传音频...");
  recorder.stop();
}

async function uploadAudio(blob, extension) {
  try {
    if (!blob.size) {
      setStatus("没有录到声音，请再试一次。", true);
      finishUpload();
      return;
    }

    setStatus("正在识别...");
    const formData = new FormData();
    formData.append("audio", blob, `voicebridge.${extension}`);
    formData.append("autoPaste", String(autoPasteEl.checked));

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
  } finally {
    finishUpload();
  }
}

function finishUpload() {
  isUploading = false;
  recordButton.disabled = false;
  setRecordIdle();
  setActionButtonsDisabled(false);
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.addEventListener("open", () => setStatus("已连接电脑端。"));
  ws.addEventListener("message", (event) => {
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
  ws.addEventListener("close", () => {
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
