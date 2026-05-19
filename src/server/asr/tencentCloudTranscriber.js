import crypto from "node:crypto";
import fs from "node:fs/promises";

const ENDPOINT = "asr.tencentcloudapi.com";
const SERVICE = "asr";
const VERSION = "2019-06-14";
const ACTION = "SentenceRecognition";

export async function transcribeWithTencentCloud({ filePath, config }) {
  const audio = await fs.readFile(filePath);
  const request = createTencentSentenceRecognitionRequest({
    audio,
    config
  });

  const response = await fetch(`https://${ENDPOINT}`, {
    method: "POST",
    headers: request.headers,
    body: request.body
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.Response?.Error) {
    const tencentError = payload.Response?.Error;
    const message = tencentError
      ? `${tencentError.Code}: ${tencentError.Message}`
      : `HTTP ${response.status}`;
    const error = new Error(`Tencent ASR failed: ${message}`);
    error.publicMessage = `腾讯云语音识别失败：${message}`;
    throw error;
  }

  const text = payload.Response?.Result?.trim();
  if (!text) {
    const error = new Error("Tencent ASR returned empty text");
    error.publicMessage = "识别完成，但腾讯云没有返回可用文字。";
    throw error;
  }

  return text;
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
