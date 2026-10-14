const TRANSCRIBE_TIMEOUT_MS = 30_000;

function relayError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

export function resolveAsrChannel(config, edgeAsr) {
  if (config.tencentSecretId && config.tencentSecretKey) return "local";
  if (typeof edgeAsr?.getAccessToken === "function" && edgeAsr.deviceId &&
      edgeAsr.supabaseUrl && edgeAsr.supabaseAnonKey) return "edge";
  return "none";
}

// The trusted relay verifies audio, device ownership and usage. No Tencent
// signature, caller-reported billing result or external upload URL reaches LAN.
export async function transcribeViaEdgeAsr({
  wavBuffer, getAccessToken, deviceId, supabaseUrl, supabaseAnonKey,
  fetchImpl = globalThis.fetch, timeoutMs = TRANSCRIBE_TIMEOUT_MS
}) {
  const accessToken = await Promise.resolve().then(getAccessToken).catch(() => null);
  if (!accessToken) throw relayError("电脑端尚未完成云端登录，无法使用语音识别。", 401);
  if (!deviceId) throw relayError("电脑端尚未完成设备配对。", 403);

  const form = new FormData();
  form.append("audio", new Blob([wavBuffer], { type: "audio/wav" }), "voice.wav");
  form.append("device_id", deviceId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Do not retry automatically: the relay may already have reserved/billed
    // this request when a network response is lost.
    const response = await fetchImpl(`${String(supabaseUrl).replace(/\/$/, "")}/functions/v1/transcribe`, {
      method: "POST",
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${accessToken}` },
      body: form,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw relayError(payload?.message || payload?.error || "云端语音识别失败，请稍后重试。", response.status || 502);
    }
    if (typeof payload.text !== "string" || !payload.text.trim()) {
      throw relayError("识别完成，但没有返回可用文字。");
    }
    return payload.text.trim();
  } catch (error) {
    if (error.publicMessage) throw error;
    throw relayError(controller.signal.aborted ? "云端语音识别超时，请重试。" : "语音识别请求失败，请检查网络后重试。");
  } finally {
    clearTimeout(timer);
  }
}
