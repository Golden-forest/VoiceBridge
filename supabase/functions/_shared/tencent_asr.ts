const ENDPOINT = "asr.tencentcloudapi.com";
const SERVICE = "asr";
const VERSION = "2019-06-14";
const ACTION = "SentenceRecognition";

export type TencentAsrConfig = {
  secretId: string;
  secretKey: string;
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
  const request = await createTencentSentenceRecognitionRequest({
    audioBase64: bytesToBase64(audioBytes),
    audioLength: audioBytes.byteLength,
    requestId,
    config
  });

  const response = await fetchImpl(`https://${ENDPOINT}`, {
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
    DataLen: audioLength
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
