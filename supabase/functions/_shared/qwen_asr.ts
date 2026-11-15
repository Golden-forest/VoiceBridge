import { removeFillerWords } from "./tencent_asr.ts";

// qwen3-asr-flash 走 OpenAI 兼容的 chat/completions，音频以 data URI 内嵌，
// 与腾讯 Flash 一样无需公网 URL，Edge 中继可直接转发。默认域名仍是
// DashScope；生产用 DASHSCOPE_BASE_URL 指向业务空间专属域名（老域名已进入
// 维护状态，不再支持新特性）。
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3-asr-flash";
// LLM 架构比传统 ASR 慢：给足预算但必须小于客户端 30s 超时。
const DEFAULT_TIMEOUT_MS = 25_000;

export type QwenAsrConfig = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
};

export async function transcribeQwenWav({
  audioBytes,
  requestId,
  config,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
}: {
  audioBytes: Uint8Array;
  requestId: string;
  config: QwenAsrConfig;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  if (!config.apiKey) {
    throw new Error("Qwen ASR credentials are not configured");
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl || DEFAULT_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: `data:audio/wav;base64,${bytesToBase64(audioBytes)}`, format: "wav" } }
          ]
        }]
      }),
      signal: controller.signal
    });
  } catch (error) {
    const message = String((error as Error)?.message || error);
    if ((error as Error)?.name === "AbortError" || /abort/i.test(message)) {
      throw new Error(`Qwen ASR timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Qwen ASR failed: ${message}`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Qwen ASR returned empty text");
  }

  console.info("Qwen ASR provider: chat/completions", {
    request_id: requestId,
    model: config.model || DEFAULT_MODEL,
    duration_ms: Date.now() - startedAt
  });

  return removeFillerWords(content.trim());
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
