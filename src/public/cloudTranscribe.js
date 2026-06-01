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

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw new Error(error.message || "获取登录状态失败，请重新登录。");
  }
  const accessToken = data?.session?.access_token;
  if (!accessToken) {
    throw new Error("请先登录后再使用云端语音识别。");
  }

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

  const response = await fetchImpl(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/transcribe`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`
    },
    body: formData
  });
  const payload = await parseJson(response);

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
