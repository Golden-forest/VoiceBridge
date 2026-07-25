const config = window.__VB_CONFIG || {};
const params = new URLSearchParams(window.location.search);
const pairingToken = params.get("pairing_token") || "";
const deviceName = params.get("device") || "VoiceBridge 电脑";
const overlay = document.querySelector("#pairingOverlay");
const deviceNameEl = document.querySelector("#pairingDeviceName");
const confirmBtn = document.querySelector("#pairingConfirmBtn");
const cancelBtn = document.querySelector("#pairingCancelBtn");
const messageEl = document.querySelector("#pairingMessage");

function setMessage(message, isError = false) {
  if (!messageEl) return;
  messageEl.textContent = message;
  messageEl.classList.toggle("error", isError);
}

function clearPairingQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("pairing_token");
  url.searchParams.delete("device");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function updatePairingVisibility(session) {
  if (!pairingToken || !overlay) return;
  overlay.classList.toggle("hidden", !session);
  if (deviceNameEl) deviceNameEl.textContent = deviceName.slice(0, 120);
}

window.addEventListener("voicebridge:auth", (event) => {
  updatePairingVisibility(event.detail?.session || null);
});

updatePairingVisibility(window.VoiceBridgeAuth?.session || null);

confirmBtn?.addEventListener("click", async () => {
  const supabase = window.VoiceBridgeAuth?.supabase;
  if (!supabase || !pairingToken || !config.supabaseUrl || !config.supabaseAnonKey) return;
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  setMessage("正在安全绑定…");
  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error("登录状态已失效，请重新登录。");
    const response = await fetch(`${config.supabaseUrl}/functions/v1/device-pairing`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: config.supabaseAnonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ action: "claim", pairing_token: pairingToken })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.message || "绑定失败，请刷新电脑二维码后重试。");
    }
    setMessage(`已绑定 ${payload.device?.name || deviceName}，电脑将自动上线。`);
    clearPairingQuery();
    confirmBtn.textContent = "绑定成功";
    setTimeout(() => overlay?.classList.add("hidden"), 1600);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "绑定失败，请稍后重试。", true);
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
  }
});

cancelBtn?.addEventListener("click", () => {
  clearPairingQuery();
  overlay?.classList.add("hidden");
});
