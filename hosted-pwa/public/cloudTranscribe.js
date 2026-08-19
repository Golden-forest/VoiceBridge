let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
const ACCESS_TOKEN_TTL_MS = 50_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;

// 测试专用：清理 token 缓存。生产代码不应调用。
export function __clearAccessTokenCacheForTests() {
  cachedAccessToken = null;
  cachedAccessTokenExpiresAt = 0;
}

async function getAccessToken(supabase) {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessTokenExpiresAt > now) {
    return cachedAccessToken;
  }
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw new Error(error.message || "获取登录状态失败，请重新登录。");
  }
  const token = data?.session?.access_token;
  if (!token) {
    throw new Error("请先登录后再使用云端语音识别。");
  }
  cachedAccessToken = token;
  cachedAccessTokenExpiresAt = now + ACCESS_TOKEN_TTL_MS;
  return token;
}

export async function transcribeCloudAudio({
  supabase = globalThis.window?.VoiceBridgeAuth?.supabase,
  audio,
  filename = "voicebridge.wav",
  durationMs,
  fetch: fetchImpl = globalThis.fetch
} = {}) {
  if (!supabase) {
    throw new Error("请先登录后再使用云端语音识别。");
  }
  if (!audio) {
    throw new Error("没有收到音频文件。");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("当前浏览器无法发起云端语音识别请求。");
  }

  const timing = { t0: Date.now(), tokenReadyAt: 0, uploadDoneAt: 0 };
  const accessToken = await getAccessToken(supabase);
  timing.tokenReadyAt = Date.now();

  const supabaseUrl = supabase.supabaseUrl || supabase.rest?.url?.replace(/\/rest\/v1\/?$/, "");
  const anonKey = supabase.supabaseKey || supabase.headers?.apikey;
  if (!supabaseUrl || !anonKey) {
    throw new Error("缺少 Supabase 云端识别配置。");
  }

  const formData = new FormData();
  formData.append("audio", audio, filename);
  if (Number.isFinite(durationMs) && durationMs > 0) {
    formData.append("duration_ms", String(Math.round(durationMs)));
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
    : null;
  let response;
  try {
    response = await fetchImpl(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/transcribe`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      },
      body: formData,
      ...(controller ? { signal: controller.signal } : {})
    });
  } catch (error) {
    if (controller && controller.signal.aborted) {
      throw new Error("云端识别超时，请检查网络后重试。");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  timing.uploadDoneAt = Date.now();
  const payload = await parseJson(response);
  console.info("[vb-timing] cloudTranscribe", {
    token_ms: timing.tokenReadyAt - timing.t0,
    server_ms: timing.uploadDoneAt - timing.tokenReadyAt,
    total_ms: Date.now() - timing.t0
  });

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || payload?.error || "云端语音识别失败，请稍后重试。");
  }

  if (typeof payload.text !== "string" || !payload.text.trim()) {
    throw new Error("识别完成，但没有返回可用文字。");
  }

  return {
    ...payload,
    text: payload.text.trim()
  };
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
