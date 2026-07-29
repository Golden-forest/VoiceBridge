import { t } from "./i18n/i18n.js";

const config = window.__VB_CONFIG || {};
const params = new URLSearchParams(window.location.search);
const pairingToken = params.get("pairing_token") || "";
const urlDeviceName = params.get("device") || "";
const deviceName = urlDeviceName || t('pairing.defaultDeviceName');
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
  setMessage(t('pairing.binding'));
  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error(t('pairing.sessionExpired'));
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
      throw new Error(payload?.message || t('pairing.bindFailedRefresh'));
    }
    setMessage(t('pairing.bound', payload.device?.name || deviceName));
    clearPairingQuery();
    confirmBtn.textContent = t('pairing.success');
    setTimeout(() => overlay?.classList.add("hidden"), 1600);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : t('pairing.failed'), true);
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
  }
});

cancelBtn?.addEventListener("click", () => {
  clearPairingQuery();
  overlay?.classList.add("hidden");
});
