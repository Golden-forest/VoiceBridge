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

class WindowSelector {
  static STORAGE_KEY = "voicebridge_selected_window";

  constructor() {
    this.el = {
      btn: document.querySelector("#windowBtn"),
      btnLabel: document.querySelector("#windowBtnLabel"),
      dropdown: document.querySelector("#windowDropdown"),
      list: document.querySelector("#windowList"),
      refreshBtn: document.querySelector("#windowRefreshBtn")
    };
    this.selectedWindow = this._loadSelection();
    this._isOpen = false;
    this._init();
  }

  _init() {
    this.el.btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggle();
    });
    this.el.refreshBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._fetchWindows();
    });
    document.addEventListener("click", (e) => {
      if (this._isOpen && !this.el.dropdown.contains(e.target)) {
        this._close();
      }
    });
    this._updateButton();
  }

  get targetWindow() {
    return this.selectedWindow;
  }

  _loadSelection() {
    try {
      return JSON.parse(localStorage.getItem(WindowSelector.STORAGE_KEY));
    } catch {
      return null;
    }
  }

  _saveSelection() {
    if (this.selectedWindow) {
      localStorage.setItem(WindowSelector.STORAGE_KEY, JSON.stringify(this.selectedWindow));
    } else {
      localStorage.removeItem(WindowSelector.STORAGE_KEY);
    }
  }

  _toggle() {
    if (this._isOpen) {
      this._close();
    } else {
      this._open();
    }
  }

  _open() {
    this._isOpen = true;
    this.el.dropdown.classList.remove("hidden");
    this._fetchWindows();
  }

  _close() {
    this._isOpen = false;
    this.el.dropdown.classList.add("hidden");
  }

  _updateButton() {
    if (this.selectedWindow) {
      this.el.btnLabel.textContent = this.selectedWindow.appName;
      this.el.btn.classList.add("active");
    } else {
      this.el.btnLabel.textContent = "光标位置";
      this.el.btn.classList.remove("active");
    }
  }

  async _fetchWindows() {
    this.el.list.innerHTML = '<p class="window-list-loading">加载中…</p>';
    try {
      const res = await fetch("/api/windows");
      const data = await res.json();
      if (!data.ok || !data.windows || data.windows.length === 0) {
        this.el.list.innerHTML = '<p class="window-list-empty">没有找到可输入的窗口</p>';
        return;
      }
      this._renderWindows(data.windows);
    } catch {
      this.el.list.innerHTML = '<p class="window-list-empty">获取窗口失败</p>';
    }
  }

  _renderWindows(groups) {
    this.el.list.innerHTML = "";
    groups.forEach((group) => {
      const groupEl = document.createElement("div");
      groupEl.className = "window-app-group";

      const label = document.createElement("div");
      label.className = "window-app-label";
      label.textContent = group.appName;
      groupEl.appendChild(label);

      group.windows.forEach((win) => {
        const btn = document.createElement("button");
        btn.className = "window-item";
        btn.type = "button";

        const isSelected = this.selectedWindow
          && this.selectedWindow.appName === group.appName
          && this.selectedWindow.windowTitle === win.title;

        if (isSelected) {
          btn.classList.add("selected");
        }

        const check = document.createElement("span");
        check.className = "window-item-check";
        check.textContent = isSelected ? "✓" : "";
        btn.appendChild(check);

        const title = document.createElement("span");
        title.className = "window-item-title";
        title.textContent = win.title;
        btn.appendChild(title);

        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (isSelected) {
            this.selectedWindow = null;
          } else {
            this.selectedWindow = {
              appName: group.appName,
              windowTitle: win.title
            };
          }
          this._saveSelection();
          this._updateButton();
          this._close();
        });

        groupEl.appendChild(btn);
      });

      this.el.list.appendChild(groupEl);
    });
  }
}

class PhrasesManager {
  static STORAGE_KEY = "voicebridge_phrases";

  constructor() {
    this.el = {
      drawer: document.querySelector("#phrasesDrawer"),
      toggle: document.querySelector("#phrasesToggle"),
      panel: document.querySelector("#phrasesPanel"),
      list: document.querySelector("#phrasesList"),
      count: document.querySelector("#phrasesCount"),
      panelCount: document.querySelector("#phrasesPanelCount"),
      addBtn: document.querySelector("#phrasesAddBtn"),
      editDoneBtn: document.querySelector("#phrasesEditDoneBtn"),
      saveBtn: document.querySelector("#savePhraseBtn"),
      dialog: document.querySelector("#addPhraseDialog"),
      dialogOverlay: document.querySelector(".add-phrase-overlay"),
      dialogInput: document.querySelector("#addPhraseInput"),
      dialogCancel: document.querySelector("#addPhraseCancelBtn"),
      dialogConfirm: document.querySelector("#addPhraseConfirmBtn"),
    };
    this.editingId = null;
    this._init();
  }

  _init() {
    this.el.toggle.addEventListener("click", () => this._toggle());
    this.el.addBtn.addEventListener("click", () => this._openAddDialog());
    this.el.dialogCancel.addEventListener("click", () => this._closeDialog());
    this.el.dialogOverlay.addEventListener("click", () => this._closeDialog());
    this.el.dialogConfirm.addEventListener("click", () => this._confirmAdd());
    this.el.editDoneBtn.addEventListener("click", () => this._exitEditMode());
    this._render();
  }

  get _phrases() {
    try {
      return JSON.parse(localStorage.getItem(PhrasesManager.STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  }

  set _phrases(arr) {
    localStorage.setItem(PhrasesManager.STORAGE_KEY, JSON.stringify(arr));
  }

  _updateCounts() {
    const n = this._phrases.length;
    this.el.count.textContent = `(${n})`;
    this.el.panelCount.textContent = `(${n})`;
  }

  _toggle() {
    this.el.drawer.classList.toggle("open");
    this.el.panel.classList.toggle("hidden");
    if (this.el.drawer.classList.contains("open")) {
      this._exitEditMode();
    }
  }

  _render() {
    const phrases = this._phrases;
    this._updateCounts();
    this.el.list.innerHTML = "";

    phrases.forEach((phrase) => {
      const li = document.createElement("li");
      li.className = "phrases-item";
      li.dataset.id = phrase.id;

      const textSpan = document.createElement("span");
      textSpan.className = "phrases-item-text";
      textSpan.textContent = phrase.text;
      li.appendChild(textSpan);

      li.addEventListener("click", (e) => {
        if (this.editingId) return;
        this._sendPhrase(phrase.text);
      });

      let longPressTimer;
      li.addEventListener("pointerdown", () => {
        longPressTimer = setTimeout(() => {
          this._enterEditMode(phrase.id);
          longPressTimer = null;
        }, 500);
      });
      li.addEventListener("pointerup", () => {
        if (longPressTimer) clearTimeout(longPressTimer);
      });
      li.addEventListener("pointerleave", () => {
        if (longPressTimer) clearTimeout(longPressTimer);
      });

      this.el.list.appendChild(li);
    });
  }

  _sendPhrase(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg = {
        type: "phrase",
        text,
        autoPaste: autoPasteEl.checked
      };
      if (windowSelector.targetWindow) {
        msg.targetWindow = windowSelector.targetWindow;
      }
      ws.send(JSON.stringify(msg));
      setStatus("已发送常用语到电脑。");
    } else {
      setStatus("发送失败，请检查连接。", true);
    }
  }

  _enterEditMode(editId) {
    this.editingId = editId;
    this.el.addBtn.classList.add("hidden");
    this.el.editDoneBtn.classList.remove("hidden");

    const items = this.el.list.querySelectorAll(".phrases-item");
    items.forEach((li) => {
      const id = li.dataset.id;
      const textSpan = li.querySelector(".phrases-item-text");
      const phrase = this._phrases.find((p) => p.id === id);
      if (!phrase) return;

      if (id === editId) {
        li.classList.add("editing");
        textSpan.classList.add("hidden");
        const input = document.createElement("textarea");
        input.className = "phrases-item-edit-input";
        input.rows = 2;
        input.value = phrase.text;
        li.insertBefore(input, textSpan.nextSibling);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "phrases-item-delete";
        deleteBtn.type = "button";
        deleteBtn.textContent = "删除";
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this._deletePhrase(id);
        });
        li.appendChild(deleteBtn);
      } else {
        li.style.opacity = "0.4";
        li.style.pointerEvents = "none";
      }
    });
  }

  _exitEditMode() {
    if (!this.editingId) return;
    this.editingId = null;
    this.el.addBtn.classList.remove("hidden");
    this.el.editDoneBtn.classList.add("hidden");
    this._saveEditChanges();
    this._render();
  }

  _saveEditChanges() {
    const phrases = this._phrases;
    const editedInput = this.el.list.querySelector(
      ".phrases-item.editing .phrases-item-edit-input"
    );
    if (!editedInput) return;

    const editedId = editedInput.closest(".phrases-item").dataset.id;
    const newText = editedInput.value.trim();
    if (!newText) {
      this._deletePhrase(editedId);
      return;
    }
    const phrase = phrases.find((p) => p.id === editedId);
    if (phrase) {
      phrase.text = newText;
      this._phrases = phrases;
    }
  }

  _deletePhrase(id) {
    const phrases = this._phrases.filter((p) => p.id !== id);
    this._phrases = phrases;
    this._render();
  }

  _openAddDialog() {
    this.el.dialogInput.value = "";
    this.el.dialog.classList.remove("hidden");
    this.el.dialogInput.focus();
  }

  _closeDialog() {
    this.el.dialog.classList.add("hidden");
  }

  _confirmAdd() {
    const text = this.el.dialogInput.value.trim();
    if (!text) return;
    const phrases = this._phrases;
    phrases.unshift({
      id: crypto.randomUUID(),
      text,
      createdAt: Date.now()
    });
    this._phrases = phrases;
    this._render();
    this._closeDialog();
  }

  addPhrase(text) {
    const exists = this._phrases.some((p) => p.text === text);
    if (exists) {
      setStatus("该常用语已存在。");
      return;
    }
    const phrases = this._phrases;
    phrases.unshift({
      id: crypto.randomUUID(),
      text,
      createdAt: Date.now()
    });
    this._phrases = phrases;
    this._render();
    setStatus("已收藏为常用语。");
  }

  showSaveButton() {
    this.el.saveBtn.classList.remove("hidden");
  }

  hideSaveButton() {
    this.el.saveBtn.classList.add("hidden");
  }
}

const phrases = new PhrasesManager();
const windowSelector = new WindowSelector();

// Quick bar wiring
const quickBar = document.querySelector("#quickBar");
const quickToggle = quickBar.querySelector(".quick-toggle");
const quickPanel = document.querySelector("#quickPanel");

quickToggle.addEventListener("click", () => {
  quickBar.classList.toggle("open");
  quickPanel.classList.toggle("hidden");
});

quickPanel.addEventListener("click", (e) => {
  const btn = e.target.closest(".quick-btn");
  if (!btn) return;
  const text = btn.dataset.text;
  if (!text) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg = {
      type: "phrase",
      text,
      autoPaste: autoPasteEl.checked
    };
    if (windowSelector.targetWindow) {
      msg.targetWindow = windowSelector.targetWindow;
    }
    ws.send(JSON.stringify(msg));
    setStatus("已发送快捷指令。");
  } else {
    setStatus("发送失败，请检查连接。", true);
  }
});

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

phrases.el.saveBtn.addEventListener("click", () => {
  const text = resultEl.textContent.trim();
  if (text && text !== "等待录音" && text !== "没有识别到文字") {
    phrases.addPhrase(text);
    phrases.el.saveBtn.textContent = "已收藏 ✓";
    phrases.el.saveBtn.classList.add("saved");
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
    if (windowSelector.targetWindow) {
      formData.append("targetAppName", windowSelector.targetWindow.appName);
      formData.append("targetWindowTitle", windowSelector.targetWindow.windowTitle);
    }

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
    phrases.showSaveButton();
    phrases.el.saveBtn.classList.remove("saved");
    phrases.el.saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> 收藏为常用语';
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
