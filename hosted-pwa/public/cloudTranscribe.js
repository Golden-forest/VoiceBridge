let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
const ACCESS_TOKEN_TTL_MS = 50_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;
// 手机直连腾讯 Flash：签名获取 / 直连 POST / 结果上报各自的超时（Task 2）。
const DIRECT_TENCENT_TIMEOUT_MS = 10_000;
const DIRECT_REPORT_TIMEOUT_MS = 5_000;

// 耗时观测（延迟诊断）：app.js 注册监听，把各段耗时汇入界面可见的快照。
// console.info("[vb-timing] ...") 原样保留（外部工具可能解析）。
let asrTimingListener = null;

export function setAsrTimingListener(listener) {
  asrTimingListener = typeof listener === "function" ? listener : null;
}

function noteAsrTiming(fields) {
  try {
    asrTimingListener?.(fields);
  } catch {
    // 观测绝不影响识别主流程。
  }
}

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
  prefetchedIssue = null,
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

  // 录音期间预取的签名（Promise 或已解析对象）：有效则跳过签名请求，
  // 说完话直接上传腾讯，省掉一次跨境 Edge 往返（含冷启动）。
  let preloaded = null;
  if (prefetchedIssue) {
    try {
      preloaded = await prefetchedIssue;
    } catch {
      preloaded = null;
    }
  }

  // 直连通道（Task 2）：签名 → 手机直传腾讯 → 上报结果；任何失败都静默回退到 Edge 中转。
  const direct = await tryDirectAsr({ baseUrl, anonKey, accessToken, audio, durationMs, fetchImpl, preloadedIssue: preloaded });
  if (direct) {
    return direct;
  }
  return transcribeViaRelay({ baseUrl, anonKey, accessToken, audio, filename, durationMs, fetchImpl });
}

// === 直连通道 ===

// 录音开始时预取签名：跨境 Edge 往返（热 ~0.5s / 冷启动 2.5~4.5s）与录音
// 并行，说完话直接上传腾讯。durationMs 传客户端的录音上限——配额只在
// report 结算时按实际时长计（reserved 行不计数），上限预留不会多扣。
// 任何失败返回 null，transcribeCloudAudio 照常走实时签名/中转，零风险回退。
export function prefetchDirectAsrSignature({
  supabase = globalThis.window?.VoiceBridgeAuth?.supabase,
  durationMs,
  fetch: fetchImpl = globalThis.fetch
} = {}) {
  const estimateBytes = Math.max(1, Math.round((Number(durationMs) || 0) / 1000 * 32_000));
  return (async () => {
    try {
      if (!supabase || typeof fetchImpl !== "function") return null;
      const accessToken = await getAccessToken(supabase);
      const supabaseUrl = supabase.supabaseUrl || supabase.rest?.url?.replace(/\/rest\/v1\/?$/, "");
      const anonKey = supabase.supabaseKey || supabase.headers?.apikey;
      if (!supabaseUrl || !anonKey) return null;
      const response = await fetchImpl(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/issue-asr-request`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          duration_ms: Math.round(Number(durationMs) || 0),
          audio_size_bytes: estimateBytes
        })
      });
      const issue = await parseJson(response);
      if (!response.ok || !issue?.ok) return null;
      console.info("[vb-timing] presign (during recording)", { ms: null, expires_at: issue.expires_at });
      noteAsrTiming({ presignedDuringRecording: true });
      return issue;
    } catch {
      return null;
    }
  })();
}

function isValidIssuePayload(issue) {
  return typeof issue?.url === "string" && issue.url.length > 0
    && Boolean(issue?.headers)
    && Number.isFinite(issue?.expires_at)
    && typeof issue?.request_id === "string";
}

async function tryDirectAsr({ baseUrl, anonKey, accessToken, audio, durationMs, fetchImpl, preloadedIssue }) {
  const t0 = Date.now();
  let issueMs = 0;
  let issue = null;
  const preloadedFresh = preloadedIssue
    && isValidIssuePayload(preloadedIssue)
    && Date.now() < preloadedIssue.expires_at * 1000;
  if (preloadedIssue && isValidIssuePayload(preloadedIssue) && !preloadedFresh) {
    // 预签名已过期（录音超过签名 TTL 等）：上报 failed 关掉服务端预留行，
    // 然后走下面的实时签名——不要直接掉到慢的中转通道。
    await reportAsrResult({
      baseUrl, anonKey, accessToken, fetchImpl,
      requestId: preloadedIssue.request_id,
      status: "failed",
      error_code: "stale_signature"
    }).catch(() => {});
  }
  if (preloadedFresh) {
    issue = preloadedIssue;
    issueMs = 0;
  } else {
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
  }

  const report = (status, extra = {}) => reportAsrResult({
    baseUrl, anonKey, accessToken, fetchImpl,
    requestId: issue?.request_id,
    status,
    // 实际录音时长随上报回写：预签名按上限预留，这里结算为真实用量。
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null,
    ...extra
  });

  if (!isValidIssuePayload(issue)) {
    // ok:true 但签名载荷不完整：尽力上报失败，避免服务端预留额度悬挂。
    await report("failed", { error_code: "invalid_issue_response" });
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
    // 成功路径 fire-and-forget：上报慢/挂起不得拖延把文字交还给用户。
    report("success", { text_length: text.length });
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
  noteAsrTiming({ channel: "direct", issueMs, asrMs: directAsrMs, totalMs: Date.now() - t0 });
}

// 结果上报：尽力而为（keepalive + 自身超时 + 吞掉所有错误），绝不影响识别结果或 UI。
// 返回的 promise 被记录到 pendingReports，仅供测试确定性等待；生产成功路径不 await。
const pendingReports = new Set();

function reportAsrResult({ baseUrl, anonKey, accessToken, fetchImpl, requestId, status, durationMs, error_code: errorCode, text_length: textLength }) {
  if (!requestId) return Promise.resolve();
  const promise = fetchWithTimeout(fetchImpl, `${baseUrl}/functions/v1/report-asr-result`, {
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
      ...(Number.isFinite(textLength) ? { text_length: textLength } : {}),
      ...(Number.isFinite(durationMs) && durationMs > 0 ? { duration_ms: durationMs } : {})
    }),
    keepalive: true
  }, DIRECT_REPORT_TIMEOUT_MS).catch(() => {
    // 上报失败不影响主流程。
  });
  pendingReports.add(promise);
  promise.then(() => pendingReports.delete(promise));
  return promise;
}

// 测试专用：等待所有进行中的上报 promise。生产代码不应调用。
export async function __waitForPendingAsrReportsForTests() {
  await Promise.allSettled([...pendingReports]);
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
  noteAsrTiming({ channel: "relay", asrMs: uploadDoneAt - t0, totalMs: Date.now() - t0 });

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
  // 与 Edge 端 tencent_asr.ts 保持相同顺序：先处理后置语气词，再处理前置语气词。
  r = r.replace(FILLER_AFTER_BOUNDARY, "$1");
  r = r.replace(FILLER_BEFORE_BOUNDARY, "$1");
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
