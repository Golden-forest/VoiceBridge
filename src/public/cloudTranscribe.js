let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
const ACCESS_TOKEN_TTL_MS = 50_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;
// 手机直连腾讯 Flash：签名获取 / 直连 POST / 结果上报各自的超时（Task 2）。
const DIRECT_TENCENT_TIMEOUT_MS = 10_000;
const DIRECT_REPORT_TIMEOUT_MS = 5_000;

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

  const accessToken = await getAccessToken(supabase);

  const supabaseUrl = supabase.supabaseUrl || supabase.rest?.url?.replace(/\/rest\/v1\/?$/, "");
  const anonKey = supabase.supabaseKey || supabase.headers?.apikey;
  if (!supabaseUrl || !anonKey) {
    throw new Error("缺少 Supabase 云端识别配置。");
  }
  const baseUrl = supabaseUrl.replace(/\/$/, "");

  // 直连通道（Task 2）：签名 → 手机直传腾讯 → 上报结果；任何失败都静默回退到 Edge 中转。
  const direct = await tryDirectAsr({ baseUrl, anonKey, accessToken, audio, durationMs, fetchImpl });
  if (direct) {
    return direct;
  }
  return transcribeViaRelay({ baseUrl, anonKey, accessToken, audio, filename, durationMs, fetchImpl });
}

// === 直连通道 ===

async function tryDirectAsr({ baseUrl, anonKey, accessToken, audio, durationMs, fetchImpl }) {
  const t0 = Date.now();
  let issueMs = 0;
  let issue = null;
  try {
    const response = await fetchImpl(`${baseUrl}/functions/v1/issue-asr-request`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        duration_ms: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0,
        audio_size_bytes: typeof audio.size === "number" ? audio.size : 0
      })
    });
    issueMs = Date.now() - t0;
    issue = await parseJson(response);
    if (!response.ok || !issue?.ok) {
      return null;
    }
  } catch {
    return null;
  }

  const report = (status, extra = {}) => reportAsrResult({
    baseUrl, anonKey, accessToken, fetchImpl,
    requestId: issue?.request_id,
    status,
    ...extra
  });

  if (typeof issue?.url !== "string" || !issue.url || !issue?.headers || !Number.isFinite(issue.expires_at)) {
    return null;
  }
  // 签名已过期（Edge 时钟与手机时钟偏差等）：视为失败，回退中转通道。
  if (Date.now() >= issue.expires_at * 1000) {
    await report("failed", { error_code: "stale_signature" });
    logDirectTiming(t0, issueMs, 0);
    return null;
  }

  const directStart = Date.now();
  try {
    const payload = await fetchWithTimeout(fetchImpl, issue.url, {
      method: "POST",
      headers: issue.headers,
      body: audio
    }, DIRECT_TENCENT_TIMEOUT_MS);
    const tencent = await parseJson(payload);
    if (!payload.ok || !tencent || tencent.code !== 0) {
      await report("failed", { error_code: `tencent_${tencent?.code ?? payload.status}` });
      logDirectTiming(t0, issueMs, Date.now() - directStart);
      return null;
    }
    const rawText = (Array.isArray(tencent.flash_result)
      ? tencent.flash_result.map((item) => item?.text || "").join("")
      : "").trim();
    const text = removeFillerWords(rawText);
    if (!text) {
      await report("failed", { error_code: "empty_text" });
      logDirectTiming(t0, issueMs, Date.now() - directStart);
      return null;
    }
    await report("success", { text_length: text.length });
    const directAsrMs = Date.now() - directStart;
    logDirectTiming(t0, issueMs, directAsrMs);
    return { ok: true, request_id: issue.request_id, text };
  } catch {
    await report("failed", { error_code: "tencent_error" });
    logDirectTiming(t0, issueMs, Date.now() - directStart);
    return null;
  }
}

function logDirectTiming(t0, issueMs, directAsrMs) {
  console.info("[vb-timing] cloudTranscribe", {
    channel: "direct",
    issue_ms: issueMs,
    direct_asr_ms: directAsrMs,
    total_ms: Date.now() - t0
  });
}

// 结果上报：尽力而为（keepalive + 自身超时 + 吞掉所有错误），绝不影响识别结果或 UI。
async function reportAsrResult({ baseUrl, anonKey, accessToken, fetchImpl, requestId, status, error_code: errorCode, text_length: textLength }) {
  if (!requestId) return;
  try {
    await fetchWithTimeout(fetchImpl, `${baseUrl}/functions/v1/report-asr-result`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        request_id: requestId,
        status,
        ...(errorCode ? { error_code: errorCode } : {}),
        ...(Number.isFinite(textLength) ? { text_length: textLength } : {})
      }),
      keepalive: true
    }, DIRECT_REPORT_TIMEOUT_MS);
  } catch {
    // 上报失败不影响主流程。
  }
}

// === Edge 中转通道（原路径，行为不变） ===

async function transcribeViaRelay({ baseUrl, anonKey, accessToken, audio, filename, durationMs, fetchImpl }) {
  const t0 = Date.now();

  const formData = new FormData();
  formData.append("audio", audio, filename);
  if (Number.isFinite(durationMs) && durationMs > 0) {
    formData.append("duration_ms", String(Math.round(durationMs)));
  }

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `${baseUrl}/functions/v1/transcribe`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      },
      body: formData
    }, TRANSCRIBE_TIMEOUT_MS);
  } catch (error) {
    if (isAbort(error)) {
      throw new Error("云端识别超时，请检查网络后重试。");
    }
    throw error;
  }
  const uploadDoneAt = Date.now();
  const payload = await parseJson(response);
  console.info("[vb-timing] cloudTranscribe", {
    channel: "relay",
    server_ms: uploadDoneAt - t0,
    total_ms: Date.now() - t0
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

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    return await fetchImpl(url, {
      ...options,
      ...(controller ? { signal: controller.signal } : {})
    });
  } catch (error) {
    if (controller && controller.signal.aborted) {
      error.name = "AbortError";
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function isAbort(error) {
  return error?.name === "AbortError" || /aborted?/i.test(String(error?.message || ""));
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// 语气词清理：与 Edge 端 _shared/tencent_asr.ts removeFillerWords 保持一致，
// 保证直连与中转两条通道返回的文本风格相同。
const FILLER_CLASS = "[嗯呃唔噢欸诶哼嘖啧]";
const BOUNDARY = "[\\s，,。.!！？?、；;：:]";
const FILLER_BEFORE_BOUNDARY = new RegExp(`${FILLER_CLASS}+(${BOUNDARY})`, "gu");
const FILLER_AFTER_BOUNDARY = new RegExp(`(${BOUNDARY})${FILLER_CLASS}+`, "gu");
const ALL_FILLER = new RegExp(`^${FILLER_CLASS}+$`, "u");
const LEADING_FILLER_3PLUS = new RegExp(`^(${FILLER_CLASS})\\1{2,}`, "u");
const TRAILING_FILLER_3PLUS = new RegExp(`(${FILLER_CLASS})\\1{2,}$`, "u");

function removeFillerWords(text) {
  if (!text) return text;

  let r = text;
  r = r.replace(FILLER_BEFORE_BOUNDARY, "$1");
  r = r.replace(FILLER_AFTER_BOUNDARY, "$1");
  if (ALL_FILLER.test(r.trim())) return "";
  r = r.replace(LEADING_FILLER_3PLUS, "");
  r = r.replace(TRAILING_FILLER_3PLUS, "");
  r = r
    .replace(/([，,。.!！？?、；;：:])\1+/gu, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，,。.!！？?、；;：:])/gu, "$1")
    .replace(/^[\s，,。.!！？?、；;：:]+/u, "")
    .trim();
  return r || "";
}
