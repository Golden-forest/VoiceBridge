const ENDPOINT = "asr.tencentcloudapi.com";
const FLASH_ENDPOINT = "asr.cloud.tencent.com";
const SERVICE = "asr";
const VERSION = "2019-06-14";
const ACTION = "SentenceRecognition";

export type TencentAsrConfig = {
  secretId: string;
  secretKey: string;
  appId?: string;
  region: string;
  engServiceType: string;
};

export async function transcribeTencentWav({
  audioBytes,
  requestId,
  config,
  fetchImpl = fetch
}: {
  audioBytes: Uint8Array;
  requestId: string;
  config: TencentAsrConfig;
  fetchImpl?: typeof fetch;
}) {
  if (config.appId) {
    try {
      const flashRequest = await createTencentFlashRecognitionRequest({
        audioBytes,
        config
      });
      const response = await fetchWithTimeout(fetchImpl, flashRequest.url, {
        method: "POST",
        headers: flashRequest.headers,
        body: toArrayBuffer(audioBytes)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.code !== 0) {
        throw new Error(payload.message || `HTTP ${response.status}`);
      }
      const text = Array.isArray(payload.flash_result)
        ? payload.flash_result.map((result: { text?: string }) => result?.text || "").join("").trim()
        : "";
      if (!text) throw new Error("Tencent FlashRecognition returned empty text");
      console.info("Tencent ASR provider: FlashRecognition");
      return text;
    } catch (error) {
      console.warn("Tencent FlashRecognition failed; falling back to SentenceRecognition:", error);
    }
  }

  const request = await createTencentSentenceRecognitionRequest({
    audioBase64: bytesToBase64(audioBytes),
    audioLength: audioBytes.byteLength,
    requestId,
    config
  });

  const response = await fetchWithTimeout(fetchImpl, `https://${ENDPOINT}`, {
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
    throw new Error(`Tencent ASR failed: ${message}`);
  }

  const result = payload.Response?.Result;
  if (typeof result !== "string" || !result.trim()) {
    throw new Error("Tencent ASR returned empty text");
  }

  return result.trim();
}

export async function createTencentFlashRecognitionRequest({
  audioBytes,
  config,
  timestamp = Math.floor(Date.now() / 1000)
}: {
  audioBytes: Uint8Array;
  config: TencentAsrConfig;
  timestamp?: number;
}) {
  assertTencentConfig(config);
  if (!config.appId) throw new Error("Tencent AppID is not configured");

  const path = `/asr/flash/v1/${encodeURIComponent(config.appId)}`;
  const params = new URLSearchParams({
    convert_num_mode: "1",
    engine_type: config.engServiceType,
    filter_dirty: "0",
    filter_modal: "1",
    filter_punc: "0",
    first_channel_only: "1",
    secretid: config.secretId,
    speaker_diarization: "0",
    timestamp: String(timestamp),
    voice_format: "wav",
    word_info: "0"
  });
  params.sort();
  const query = params.toString();
  const authorization = bytesToBase64(
    await hmacSha1Bytes(encodeUtf8(config.secretKey), `POST${FLASH_ENDPOINT}${path}?${query}`)
  );

  return {
    url: `https://${FLASH_ENDPOINT}${path}?${query}`,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(audioBytes.byteLength),
      Host: FLASH_ENDPOINT
    }
  };
}

export async function createTencentSentenceRecognitionRequest({
  audioBase64,
  audioLength,
  requestId,
  config,
  timestamp = Math.floor(Date.now() / 1000)
}: {
  audioBase64: string;
  audioLength: number;
  requestId: string;
  config: TencentAsrConfig;
  timestamp?: number;
}) {
  assertTencentConfig(config);

  const payload = {
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: config.engServiceType,
    SourceType: 1,
    VoiceFormat: "wav",
    UsrAudioKey: `voicebridge-${requestId}`,
    Data: audioBase64,
    DataLen: audioLength,
    FilterDirty: 0,
    FilterModal: 1,
    FilterPunc: 0,
    ConvertNumMode: 1
  };

  const body = JSON.stringify(payload);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${ENDPOINT}\n`;
  const signedHeaders = "content-type;host";
  const hashedRequestPayload = await sha256Hex(body);
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
    await sha256Hex(canonicalRequest)
  ].join("\n");
  const secretDate = await hmacSha256Bytes(encodeUtf8(`TC3${config.secretKey}`), date);
  const secretService = await hmacSha256Bytes(secretDate, SERVICE);
  const secretSigning = await hmacSha256Bytes(secretService, "tc3_request");
  const signature = bytesToHex(await hmacSha256Bytes(secretSigning, stringToSign));
  const authorization = [
    `TC3-HMAC-SHA256 Credential=${config.secretId}/${credentialScope}`,
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
      "X-TC-Region": config.region
    }
  };
}

function assertTencentConfig(config: TencentAsrConfig) {
  if (!config.secretId || !config.secretKey) {
    throw new Error("Tencent ASR credentials are not configured");
  }
}

async function sha256Hex(message: string) {
  const digest = await crypto.subtle.digest("SHA-256", encodeUtf8(message));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Bytes(key: Uint8Array, message: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encodeUtf8(message));
  return new Uint8Array(signature);
}

async function hmacSha1Bytes(key: Uint8Array, message: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encodeUtf8(message));
  return new Uint8Array(signature);
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodeUtf8(value: string) {
  return new TextEncoder().encode(value);
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
