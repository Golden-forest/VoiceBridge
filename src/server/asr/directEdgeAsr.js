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
 * @param {string} params.supabaseUrl Edge 所在的 Supabase 项目 URL
 * @param {string} params.supabaseAnonKey Supabase anon key（apikey 头）
 * @param {Function} [params.fetchImpl] 可注入的 fetch（测试用）
 * @returns {Promise<string>} 已做语气词清理的识别文本
 */
export async function transcribeViaEdgeAsr({
  wavBuffer,
  getAccessToken,
  supabaseUrl,
  supabaseAnonKey,
  fetchImpl = globalThis.fetch
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

  const issue = await postJson(fetchImpl, `${baseUrl}/functions/v1/issue-asr-request`, {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${accessToken}`
  }, {
    duration_ms: Math.max(1, Math.round(wavBuffer.length / WAV_BYTES_PER_MS)),
    audio_size_bytes: wavBuffer.length
  }, ISSUE_TIMEOUT_MS).catch(() => null);

  if (!issue || !issue.response.ok || !issue.payload?.ok) {
    const status = issue?.response.status;
    const message = issue?.payload?.message;
    if (status === 429 || status === 413) {
      throw edgeError(message || "云端语音识别请求被拒绝。", status);
    }
    throw edgeError(message || "云端签发识别请求失败，请稍后再重试。");
  }

  const requestId = issue.payload.request_id;
  const report = (status, extra = {}) =>
    reportAsrResult({ fetchImpl, baseUrl, supabaseAnonKey, accessToken, requestId, status, ...extra });

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

  // 成功上报尽力而为：失败不影响识别结果。
  await report("success", { textLength: text.length });
  return text;
}

async function reportAsrResult({ fetchImpl, baseUrl, supabaseAnonKey, accessToken, requestId, status, errorCode, textLength }) {
  if (!requestId) return;
  await postJson(fetchImpl, `${baseUrl}/functions/v1/report-asr-result`, {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${accessToken}`
  }, {
    request_id: requestId,
    status,
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(Number.isFinite(textLength) ? { text_length: textLength } : {})
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
