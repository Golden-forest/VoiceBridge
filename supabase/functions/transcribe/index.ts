import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getPlanLimit, isPaidStatus } from "../_shared/plan_limits.ts";
import { transcribeTencentWav } from "../_shared/tencent_asr.ts";

const PROVIDER = "tencent";
type SupabaseClientLike = ReturnType<typeof createClient<any, "public", any>>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse("method_not_allowed", "仅支持 POST 请求。", 405);
  }

  const requestId = crypto.randomUUID();
  let userId = "";
  let durationMs: number | null = null;
  let audioSizeBytes = 0;
  let serviceClient: SupabaseClientLike | null = null;

  try {
    const env = getEnv();
    const authHeader = req.headers.get("Authorization") || "";
    const authClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    serviceClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);

    const { data, error } = await authClient.auth.getUser();
    if (error || !data.user) {
      return errorResponse("unauthorized", "请先登录后再使用云端语音识别。", 401);
    }
    userId = data.user.id;

    const formData = await req.formData();
    const audio = formData.get("audio");
    if (!(audio instanceof File)) {
      durationMs = readClientDurationMs(formData);
      await recordUsage(serviceClient, { userId, requestId, durationMs, audioSizeBytes, status: "rejected", errorCode: "missing_audio" });
      return errorResponse("missing_audio", "没有收到音频文件。", 400);
    }

    audioSizeBytes = audio.size;
    if (!isWavFile(audio)) {
      await recordUsage(serviceClient, { userId, requestId, durationMs, audioSizeBytes, status: "rejected", errorCode: "unsupported_audio_format" });
      return errorResponse("unsupported_audio_format", "云端识别目前仅支持 WAV 音频。", 415);
    }

    const audioBytes = new Uint8Array(await audio.arrayBuffer());
    const resolvedDurationMs = parsePcmWavDurationMs(audioBytes) ?? readClientDurationMs(formData);
    if (typeof resolvedDurationMs !== "number" || !Number.isFinite(resolvedDurationMs) || resolvedDurationMs <= 0) {
      await recordUsage(serviceClient, { userId, requestId, durationMs, audioSizeBytes, status: "rejected", errorCode: "invalid_duration" });
      return errorResponse("invalid_duration", "无法确认音频时长，请重新录音后再试。", 400);
    }
    durationMs = resolvedDurationMs;

    const durationSeconds = Math.ceil(resolvedDurationMs / 1000);
    const subscription = await getSubscription(serviceClient, userId);
    const plan = isPaidStatus(subscription?.status) ? subscription?.plan : "free";
    const limits = getPlanLimit(plan);

    if (durationSeconds > limits.maxAudioSeconds) {
      await recordUsage(serviceClient, { userId, requestId, durationMs, audioSizeBytes, status: "rejected", errorCode: "audio_too_long" });
      return errorResponse("audio_too_long", `单次录音最长支持 ${limits.maxAudioSeconds} 秒。`, 413);
    }

    const rateLimitCount = await countRecentUsage(serviceClient, userId);
    if (rateLimitCount >= limits.rateLimitPerMinute) {
      await recordUsage(serviceClient, { userId, requestId, durationMs, audioSizeBytes, status: "rejected", errorCode: "rate_limited" });
      return errorResponse("rate_limited", "请求过于频繁，请稍后再试。", 429);
    }

    const usedSeconds = await getCurrentMonthUsedSeconds(serviceClient, userId);
    if (usedSeconds + durationSeconds > limits.monthlySeconds) {
      await recordUsage(serviceClient, { userId, requestId, durationMs, audioSizeBytes, status: "rejected", errorCode: "monthly_quota_exceeded" });
      return errorResponse("monthly_quota_exceeded", "本月云端语音识别额度已用完。", 402);
    }

    const text = await transcribeTencentWav({
      audioBytes,
      requestId,
      config: {
        secretId: env.tencentSecretId,
        secretKey: env.tencentSecretKey,
        region: env.tencentAsrRegion,
        engServiceType: env.tencentAsrEngServiceType
      }
    });

    await recordUsage(serviceClient, { userId, requestId, durationMs, audioSizeBytes, status: "success" });
    return jsonResponse({ ok: true, request_id: requestId, text });
  } catch (error) {
    console.error("Transcribe function error:", error);
    if (userId && serviceClient) {
      await recordUsage(serviceClient, {
        userId,
        requestId,
        durationMs,
        audioSizeBytes,
        status: "failed",
        errorCode: "transcription_failed"
      });
    }
    return errorResponse("transcription_failed", "云端语音识别失败，请稍后重试。", 500);
  }
});

function getEnv() {
  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    tencentSecretId: requireEnv("TENCENT_SECRET_ID"),
    tencentSecretKey: requireEnv("TENCENT_SECRET_KEY"),
    tencentAsrRegion: Deno.env.get("TENCENT_ASR_REGION") || "ap-shanghai",
    tencentAsrEngServiceType: Deno.env.get("TENCENT_ASR_ENG_SERVICE_TYPE") || "16k_zh"
  };
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function getSubscription(serviceClient: SupabaseClientLike, userId: string) {
  const { data, error } = await serviceClient
    .from("subscriptions")
    .select("plan,status,current_period_end,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("Failed to fetch subscription:", error);
  }
  return data;
}

async function getCurrentMonthUsedSeconds(serviceClient: SupabaseClientLike, userId: string) {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  const { data, error } = await serviceClient
    .from("usage_events")
    .select("audio_duration_ms")
    .eq("user_id", userId)
    .eq("status", "success")
    .gte("created_at", since.toISOString());
  if (error) {
    console.error("Failed to fetch usage events:", error);
    throw new Error("Usage lookup failed");
  }

  return (data || []).reduce((sum, row) => {
    const value = Number(row.audio_duration_ms || 0);
    return sum + (Number.isFinite(value) && value > 0 ? Math.ceil(value / 1000) : 0);
  }, 0);
}

async function countRecentUsage(serviceClient: SupabaseClientLike, userId: string) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await serviceClient
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  if (error) {
    console.error("Failed to fetch recent usage count:", error);
    return 0;
  }
  return count || 0;
}

async function recordUsage(
  serviceClient: SupabaseClientLike,
  {
    userId,
    requestId,
    durationMs,
    audioSizeBytes,
    status,
    errorCode
  }: {
    userId: string;
    requestId: string;
    durationMs: number | null;
    audioSizeBytes: number;
    status: "success" | "failed" | "rejected";
    errorCode?: string;
  }
) {
  try {
    const { error } = await serviceClient.from("usage_events").insert({
      user_id: userId,
      request_id: requestId,
      provider: PROVIDER,
      mode: "cloud",
      audio_duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs as number) : null,
      audio_size_bytes: audioSizeBytes || null,
      status,
      error_code: errorCode || null
    });
    if (error) {
      console.error("Failed to insert usage event:", error);
    }
  } catch (error) {
    console.error("Failed to insert usage event:", error);
  }
}

function errorResponse(code: string, message: string, status: number) {
  return jsonResponse({ ok: false, code, message }, status);
}

function isWavFile(file: File) {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave" || name.endsWith(".wav");
}

function readClientDurationMs(formData: FormData) {
  const value = Number(formData.get("duration_ms"));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parsePcmWavDurationMs(bytes: Uint8Array) {
  if (bytes.byteLength < 44) return null;
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") return null;

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = readUint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > bytes.byteLength) return null;

    if (chunkId === "fmt " && chunkSize >= 16) {
      const audioFormat = readUint16Le(bytes, dataOffset);
      if (audioFormat !== 1) return null;
      channels = readUint16Le(bytes, dataOffset + 2);
      sampleRate = readUint32Le(bytes, dataOffset + 4);
      bitsPerSample = readUint16Le(bytes, dataOffset + 14);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!bytesPerSecond || !dataBytes) return null;
  return Math.round((dataBytes / bytesPerSecond) * 1000);
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint16Le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32Le(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}
