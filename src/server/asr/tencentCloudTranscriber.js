import crypto from "node:crypto";
import fs from "node:fs/promises";

const ENDPOINT = "asr.tencentcloudapi.com";
const SERVICE = "asr";
const VERSION = "2019-06-14";
const ACTION = "SentenceRecognition";

const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 2000];

export async function transcribeWithTencentCloud({ filePath, config }) {
  const audio = await fs.readFile(filePath);

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const request = createTencentSentenceRecognitionRequest({
        audio,
        config
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);

      let response;
      try {
        response = await fetch(`https://${ENDPOINT}`, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: controller.signal
        });
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === "AbortError") {
          const error = new Error("Tencent ASR request timed out after 30s");
          error.publicMessage = "语音识别请求超时，请重试。";
          err = error;
        }
        throw err;
      }
      clearTimeout(timeoutId);

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || payload.Response?.Error) {
        const status = response.status;
        const tencentError = payload.Response?.Error;
        const message = tencentError
          ? `${tencentError.Code}: ${tencentError.Message}`
          : `HTTP ${status}`;

        // 4xx errors are not retried
        if (status >= 400 && status < 500) {
          const error = new Error(`Tencent ASR failed: ${message}`);
          error.publicMessage = `腾讯云语音识别失败：${message}`;
          throw error;
        }

        // 5xx or response error without status — retry
        const error = new Error(`Tencent ASR failed: ${message}`);
        throw error;
      }

      const result = payload.Response?.Result;
      if (typeof result !== "string" || !result.trim()) {
        const error = new Error("Tencent ASR returned empty text");
        error.publicMessage = "识别完成，但腾讯云没有返回可用文字。";
        throw error;
      }

      return result.trim();
    } catch (err) {
      lastError = err;

      // Do not retry on 4xx or business logic errors
      if (err.publicMessage) {
        throw err;
      }

      // Network errors (AbortError, TypeError) and 5xx are retryable
      const isRetryable =
        err.name === "AbortError" ||
        err instanceof TypeError ||
        (err.message && err.message.startsWith("Tencent ASR failed"));

      if (!isRetryable || attempt >= MAX_RETRIES) {
        throw err;
      }

      const delay = RETRY_DELAYS[attempt] || 2000;
      console.warn(
        `Tencent ASR attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export function createTencentSentenceRecognitionRequest({
  audio,
  config,
  timestamp = Math.floor(Date.now() / 1000)
}) {
  const payload = {
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: config.tencentAsrEngServiceType,
    SourceType: 1,
    VoiceFormat: config.tencentAsrVoiceFormat,
    UsrAudioKey: `voicebridge-${timestamp}`,
    Data: audio.toString("base64"),
    DataLen: audio.length
  };

  const body = JSON.stringify(payload);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${ENDPOINT}\n`;
  const signedHeaders = "content-type;host";
  const hashedRequestPayload = sha256(body);
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload
  ].join("\n");
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha256(canonicalRequest)
  ].join("\n");
  const secretDate = hmacSha256(`TC3${config.tencentSecretKey}`, date);
  const secretService = hmacSha256(secretDate, SERVICE);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = hmacSha256(secretSigning, stringToSign, "hex");
  const authorization = [
    `TC3-HMAC-SHA256 Credential=${config.tencentSecretId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`
  ].join(", ");

  return {
    body,
    payload,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: ENDPOINT,
      "X-TC-Action": ACTION,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": VERSION,
      "X-TC-Region": config.tencentAsrRegion
    }
  };
}

function sha256(message) {
  return crypto.createHash("sha256").update(message).digest("hex");
}

function hmacSha256(key, message, encoding) {
  return crypto.createHmac("sha256", key).update(message).digest(encoding);
}
