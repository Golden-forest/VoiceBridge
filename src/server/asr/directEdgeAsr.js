// Edge 签名直连识别（LAN 模式，Task 5）：桌面端 LAN 服务在本地缺少腾讯云
// 凭证时，向 Edge Function issue-asr-request 逐次申请一次性签名 URL，
// 自己把 WAV 音频 POST 给腾讯云，再通过 report-asr-result 关闭用量记录。
// 腾讯云密钥永远不出 Edge：只有一次性签名经过网络，且只存在于内存中。
//
// 协议与手机端直连通道（src/public/cloudTranscribe.js，Task 2）保持一致，
// 文本语气词清理复用 removeFillerWords.js（与 Edge 端 _shared/tencent_asr.ts
// 字节级一致），返回已清理的文本。

import { removeFillerWords } from "./removeFillerWords.js";

const ISSUE_TIMEOUT_MS = 10_000;
const TENCENT_TIMEOUT_MS = 10_000;
const REPORT_TIMEOUT_MS = 5_000;
// 转换后的 WAV 固定为 16kHz / 16bit / 单声道：每毫秒 32 字节。
const WAV_BYTES_PER_MS = 32;

function edgeError(publicMessage, statusCode = 502) {
  const error = new Error(publicMessage);
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}

/**
 * 识别通道决策：本地凭证存在时优先本地路径（.env 开发场景），
 * 否则在具备 Edge 签名上下文（token 提供者 + Supabase 配置）时走直连。
 */
export function resolveAsrChannel(config, edgeAsr) {
  if (config.tencentSecretId && config.tencentSecretKey) {
    return "local";
  }
  if (
    edgeAsr &&
    typeof edgeAsr.getAccessToken === "function" &&
    edgeAsr.supabaseUrl &&
    edgeAsr.supabaseAnonKey
  ) {
    return "edge";
  }
  return "none";
}

/**
 * 通过 Edge 逐次签名直连腾讯云识别一段 WAV。
 *
 * @param {object} params
 * @param {Buffer} params.wavBuffer 16kHz/16bit/mono WAV 字节（audioConverter 输出）
 * @param {() => Promise<string|null>} params.getAccessToken Supabase 会话 access token 提供者
 * @param {string} [params.deviceId] 已绑定桌面设备 ID，用于把匿名运行身份映射到真实账号
 * @param {string} params.supabaseUrl Edge 所在的 Supabase 项目 URL
 * @param {string} params.supabaseAnonKey Supabase anon key（apikey 头）
 * @param {Function} [params.fetchImpl] 可注入的 fetch（测试用）
 * @param {Promise<object|null>|object|null} [params.prefetchedIssue] 录音期间预取的签名
 *   （createAsrPrefetchCache.consume() 的产物；Promise 或已解析对象）。有效则跳过
 *   实时签发的跨境往返；过期则上报 failed 关闭服务端预留后走实时签发。
 * @returns {Promise<string>} 已做语气词清理的识别文本
 */
export async function transcribeViaEdgeAsr({
  wavBuffer,
  getAccessToken,
  deviceId,
  supabaseUrl,
  supabaseAnonKey,
  fetchImpl = globalThis.fetch,
  prefetchedIssue = null
}) {
  const baseUrl = String(supabaseUrl).replace(/\/$/, "");
  let accessToken = null;
  try {
    accessToken = await getAccessToken();
  } catch {
    accessToken = null;
  }
  if (!accessToken) {
    throw edgeError("电脑端尚未完成云端登录，无法使用语音识别。", 401);
  }

  // 实际时长随所有上报回写：预取按录音上限预留的行结算为真实用量。
  const actualDurationMs = Math.max(1, Math.round(wavBuffer.length / WAV_BYTES_PER_MS));

  const issueUrl = `${baseUrl}/functions/v1/issue-asr-request`;
  const issueHeaders = {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${accessToken}`
  };

  // 预取签名（录音期间并行申请，与手机端云端直连 fc155b2 同一思路）：
  // 结构有效且未过期 → 直接用；过期 → 上报 failed 关掉预留行再实时签发。
  let preloaded = null;
  if (prefetchedIssue) {
    try {
      preloaded = await prefetchedIssue;
    } catch {
      preloaded = null;
    }
  }

  let issue = null;
  if (isValidIssue(preloaded) && Date.now() < preloaded.expires_at * 1000) {
    issue = { response: { ok: true, status: 200 }, payload: preloaded };
  } else {
    if (isValidIssue(preloaded)) {
      await reportAsrResult({
        fetchImpl, baseUrl, supabaseAnonKey, accessToken, deviceId,
        requestId: preloaded.request_id,
        status: "failed",
        errorCode: "stale_signature",
        durationMs: actualDurationMs
      });
    }
    const issueBody = {
      duration_ms: actualDurationMs,
      audio_size_bytes: wavBuffer.length,
      ...(deviceId ? { device_id: deviceId } : {})
    };
    // 签发请求体很小；网络错误或 5xx 时立即重试一次，避免一次瞬时抖动让整段
    // 已录好的音频作废。4xx（权限、额度、时长）属于确定性拒绝，不重试。
    for (let attempt = 0; attempt < 2; attempt++) {
      issue = await postJson(fetchImpl, issueUrl, issueHeaders, issueBody, ISSUE_TIMEOUT_MS).catch(() => null);
      if (issue && issue.response.status < 500) break;
    }
  }

  if (!issue || !issue.response.ok || !issue.payload?.ok) {
    const status = issue?.response.status;
    const message = issue?.payload?.message;
    throw edgeError(
      message || "云端签发识别请求失败，请稍后再重试。",
      Number.isInteger(status) ? status : 502
    );
  }

  const requestId = issue.payload.request_id;
  const report = (status, extra = {}) =>
    reportAsrResult({ fetchImpl, baseUrl, supabaseAnonKey, accessToken, deviceId, requestId, status, durationMs: actualDurationMs, ...extra });

  const url = issue.payload.url;
  const headers = issue.payload.headers;
  const expiresAt = issue.payload.expires_at;
  if (typeof url !== "string" || !url || !headers || !Number.isFinite(expiresAt)) {
    // ok:true 但载荷不完整：尽力上报失败，避免服务端预留额度悬挂。
    await report("failed", { errorCode: "invalid_issue_response" });
    throw edgeError("云端签发识别请求返回不完整。");
  }
  if (Date.now() >= expiresAt * 1000) {
    await report("failed", { errorCode: "stale_signature" });
    throw edgeError("签名已过期，请重试。");
  }

  let tencentResponse;
  try {
    tencentResponse = await fetchWithTimeout(fetchImpl, url, {
      method: "POST",
      headers,
      body: wavBuffer
    }, TENCENT_TIMEOUT_MS);
  } catch {
    await report("failed", { errorCode: "tencent_error" });
    throw edgeError("语音识别请求失败，请检查网络后重试。");
  }

  const tencent = await parseJson(tencentResponse);
  if (!tencentResponse.ok || !tencent || tencent.code !== 0) {
    await report("failed", { errorCode: `tencent_${tencent?.code ?? tencentResponse.status}` });
    throw edgeError("腾讯云语音识别失败，请稍后再重试。");
  }

  const rawText = (Array.isArray(tencent.flash_result)
    ? tencent.flash_result.map((item) => item?.text || "").join("")
    : "").trim();
  // 语气词清理与 Edge / 手机端通道保持一致；清理后为空同样视为失败。
  const text = removeFillerWords(rawText);
  if (!text) {
    await report("failed", { errorCode: "empty_text" });
    throw edgeError("识别完成，但没有返回可用文字。");
  }

  // 成功上报 fire-and-forget（与手机端直连通道一致）：上报慢/挂起不得拖延
  // 把文字交还给手机，否则识别完还要白等一次代理/公网往返。
  wrapPendingReport(report("success", { textLength: text.length }));
  return text;
}

function isValidIssue(payload) {
  return Boolean(
    payload &&
    typeof payload.url === "string" && payload.url.length > 0 &&
    payload.headers &&
    Number.isFinite(payload.expires_at) &&
    typeof payload.request_id === "string"
  );
}

// 预取看门狗在签名过期后的宽限；正常路径 consume() 会先取消它。
const PREFETCH_WATCHDOG_GRACE_MS = 5_000;
// 预取按录音上限预留、结算实际时长（与手机端云端直连预取 fc155b2 同一套
// 记账）。60s = LAN 录音上限。
const PREFETCH_MAX_DURATION_MS = 60_000;
const PREFETCH_MIN_DURATION_MS = 1_000;

/**
 * LAN 签名预取缓存（每个 LAN 服务一个实例）：手机开始录音时经 WS 发来
 * asr-prefetch，这里立即向 Edge 申请一次性签名（跨境往返与录音并行），
 * 音频上传到达时 consume() 一次性取走——识别不再串行等待签发。
 *
 * 配额说明：签发会在服务端预留一行 usage（按上限预留、结算实际时长）。
 * processing 行计入月配额且服务端无清扫任务，因此看门狗 + close() 把未
 * 消费的预留关闭是硬要求：取消录音 / 网络切换重建服务都不能泄漏配额。
 *
 * @returns {{ begin(durationMs: number): Promise<object|null>|null, consume(): Promise<object|null>|null, close(): Promise<void> }}
 */
export function createAsrPrefetchCache({
  getAccessToken,
  deviceId,
  supabaseUrl,
  supabaseAnonKey,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
} = {}) {
  const baseUrl = String(supabaseUrl || "").replace(/\/$/, "");
  let pending = null; // 当前预取 promise（resolve 为 issue 载荷或 null）
  let watchdog = null;

  const clearWatchdog = () => {
    if (watchdog !== null) {
      clearTimeoutImpl(watchdog);
      watchdog = null;
    }
  };

  const closeReservation = (issue, errorCode) => {
    if (!isValidIssue(issue)) return;
    void Promise.resolve()
      .then(() => getAccessToken())
      .catch(() => null)
      .then((accessToken) => {
        if (!accessToken) return;
        return reportAsrResult({
          fetchImpl, baseUrl, supabaseAnonKey, accessToken, deviceId,
          requestId: issue.request_id,
          status: "failed",
          errorCode
        });
      })
      .catch(() => { /* 尽力而为 */ });
  };

  return {
    /** 开始（或复用）一次预取；任何失败静默返回 null，上传时走实时签发。 */
    begin(durationMs) {
      if (!baseUrl || !supabaseAnonKey || typeof getAccessToken !== "function") return null;
      if (pending) return pending; // 双击录音 / 双手机并发：复用同一次预留
      const clamped = Math.min(
        PREFETCH_MAX_DURATION_MS,
        Math.max(PREFETCH_MIN_DURATION_MS, Math.round(Number(durationMs) || 0) || PREFETCH_MIN_DURATION_MS)
      );

      const attempt = (async () => {
        let accessToken = null;
        try {
          accessToken = await getAccessToken();
        } catch {
          accessToken = null;
        }
        if (!accessToken) return null;
        const { response, payload } = await postJson(fetchImpl, `${baseUrl}/functions/v1/issue-asr-request`, {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${accessToken}`
        }, {
          duration_ms: clamped,
          audio_size_bytes: clamped * WAV_BYTES_PER_MS,
          ...(deviceId ? { device_id: deviceId } : {})
        }, ISSUE_TIMEOUT_MS).catch(() => ({ response: { ok: false, status: 0 }, payload: null }));
        if (!response.ok || !payload?.ok || !isValidIssue(payload)) return null;
        // 签名到货即挂看门狗：过期仍未被 consume 就关闭预留行。
        if (now() < payload.expires_at * 1000) {
          clearWatchdog();
          watchdog = setTimeoutImpl(() => {
            watchdog = null;
            const unconsumed = pending;
            pending = null;
            void Promise.resolve(unconsumed)
              .catch(() => null)
              .then((issue) => closeReservation(issue, "stale_signature"));
          }, Math.max(0, payload.expires_at * 1000 - now()) + PREFETCH_WATCHDOG_GRACE_MS);
          watchdog?.unref?.();
        }
        return payload;
      })().catch(() => null);

      // 失败的预取（null）不占缓存槽：下一次 begin() 可以重试。
      const wrapped = attempt.then((result) => {
        if (pending === wrapped && result == null) pending = null;
        return result;
      });
      pending = wrapped;

      return wrapped;
    },

    /** 音频上传到达时取走预取（一次性）；没有预取或已消费返回 null。 */
    consume() {
      const issue = pending;
      pending = null;
      clearWatchdog();
      return issue;
    },

    /** 服务关闭（网络切换重建等）时调用：关闭未消费的预留，避免配额泄漏。 */
    async close() {
      const unconsumed = pending;
      pending = null;
      clearWatchdog();
      if (unconsumed) {
        closeReservation(await unconsumed.catch(() => null), "canceled");
      }
    }
  };
}

// 测试专用：等待所有进行中的成功上报 promise。生产代码不应调用。
const pendingReports = new Set();
const wrapPendingReport = (promise) => {
  pendingReports.add(promise);
  promise.then(() => pendingReports.delete(promise), () => pendingReports.delete(promise));
};
export async function __waitForPendingAsrReportsForTests() {
  await Promise.allSettled([...pendingReports]);
}

async function reportAsrResult({ fetchImpl, baseUrl, supabaseAnonKey, accessToken, deviceId, requestId, status, errorCode, textLength, durationMs }) {
  if (!requestId) return;
  await postJson(fetchImpl, `${baseUrl}/functions/v1/report-asr-result`, {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${accessToken}`
  }, {
    request_id: requestId,
    status,
    ...(deviceId ? { device_id: deviceId } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(Number.isFinite(textLength) ? { text_length: textLength } : {}),
    // 结算实际时长：预取行按录音上限预留（reserved 不计费），这里覆写为真实用量。
    ...(Number.isFinite(durationMs) && durationMs > 0 ? { duration_ms: Math.round(durationMs) } : {})
  }, REPORT_TIMEOUT_MS).catch(() => {
    // 上报失败不影响主流程。
  });
}

async function postJson(fetchImpl, url, headers, body, timeoutMs) {
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
  return { response, payload: await parseJson(response) };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      error.name = "AbortError";
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
