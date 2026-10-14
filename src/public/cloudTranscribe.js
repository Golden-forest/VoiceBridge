const TRANSCRIBE_TIMEOUT_MS = 30_000;
let asrTimingListener = null;

export function setAsrTimingListener(listener) {
  asrTimingListener = typeof listener === "function" ? listener : null;
}

// The relay validates the actual audio and settles usage on the server.
// Always read Supabase's current session; never cache credentials independently.
export async function transcribeCloudAudio({
  supabase = globalThis.window?.VoiceBridgeAuth?.supabase,
  audio,
  filename = "voicebridge.wav",
  durationMs,
  expectedUserId,
  signal,
  fetch: fetchImpl = globalThis.fetch
} = {}) {
  if (!supabase) throw new Error("请先登录后再使用云端语音识别。");
  if (!audio) throw new Error("没有收到音频文件。");
  if (typeof fetchImpl !== "function") throw new Error("当前浏览器无法发起云端语音识别请求。");
  throwIfAborted(signal);
  const { data, error } = await supabase.auth.getSession();
  throwIfAborted(signal);
  if (error) throw new Error(error.message || "获取登录状态失败，请重新登录。");
  const session = data?.session;
  if (!session?.access_token) throw new Error("请先登录后再使用云端语音识别。");
  if (expectedUserId && session.user?.id !== expectedUserId) {
    throw new DOMException("账号已切换，识别已取消", "AbortError");
  }
  const supabaseUrl = supabase.supabaseUrl || supabase.rest?.url?.replace(/\/rest\/v1\/?$/, "");
  const anonKey = supabase.supabaseKey || supabase.headers?.apikey;
  if (!supabaseUrl || !anonKey) throw new Error("缺少 Supabase 云端识别配置。");

  const body = new FormData();
  body.append("audio", audio, filename);
  if (Number.isFinite(durationMs) && durationMs > 0) body.append("duration_ms", String(Math.round(durationMs)));
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, TRANSCRIBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    throwIfAborted(signal);
    const response = await fetchImpl(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/transcribe`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${session.access_token}` },
      body,
      signal: controller.signal
    });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    throwIfAborted(signal);
    throwIfAborted(controller.signal);
    const totalMs = Date.now() - startedAt;
    console.info("[vb-timing] cloudTranscribe", { channel: "relay", server_ms: totalMs, total_ms: totalMs });
    try { asrTimingListener?.({ channel: "relay", asrMs: totalMs, totalMs }); } catch { /* Observation cannot fail recognition. */ }
    if (!response.ok || !payload?.ok) throw new Error(payload?.message || payload?.error || "云端语音识别失败，请稍后重试。");
    if (typeof payload.text !== "string" || !payload.text.trim()) throw new Error("识别完成，但没有返回可用文字。");
    return { ...payload, text: payload.text.trim() };
  } catch (error) {
    if (signal?.aborted) throw new DOMException("识别已取消", "AbortError");
    if (controller.signal.aborted) throw new Error("云端识别超时，请检查网络后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("识别已取消", "AbortError");
}
