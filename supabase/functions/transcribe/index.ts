import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { ERROR_CODE_QUOTA_EXCEEDED, USAGE_PROVIDER_TENCENT_CLOUD } from "../_shared/contracts.ts";
import { getPlanLimit, isPaidStatus } from "../_shared/plan_limits.ts";
import { transcribeTencentWav } from "../_shared/tencent_asr.ts";
import { parsePcmWavDurationMs } from "../_shared/wav.ts";

const PROVIDER = USAGE_PROVIDER_TENCENT_CLOUD;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
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
  let usageReserved = false;

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
    if (audioSizeBytes > MAX_AUDIO_BYTES) {
      await recordUsage(serviceClient, { userId, requestId, durationMs, audioSizeBytes, status: "rejected", errorCode: "audio_too_large" });
      return errorResponse("audio_too_large", "音频文件太大，请缩短录音后再试。", 413);
    }

    const audioBytes = new Uint8Array(await audio.arrayBuffer());
    const resolvedDurationMs = parsePcmWavDurationMs(audioBytes);
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

    const reservationError = await reserveTranscribeUsage(serviceClient, {
      userId,
      requestId,
      durationMs,
      audioSizeBytes,
      monthlySeconds: limits.monthlySeconds,
      rateLimitPerMinute: limits.rateLimitPerMinute
    });
    if (reservationError) {
      const message = reservationError === ERROR_CODE_QUOTA_EXCEEDED
        ? "本月云端语音识别额度已用完。"
        : reservationError === "rate_limited"
          ? "请求过于频繁，请稍后再试。"
          : "云端语音识别请求已存在，请稍后再试。";
      return errorResponse(reservationError, message, 429);
    }
    usageReserved = true;

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

    await updateReservedUsage(serviceClient, { userId, requestId, status: "success" });
    return jsonResponse({ ok: true, request_id: requestId, text });
  } catch (error) {
    console.error("Transcribe function error:", error);
    if (userId && serviceClient) {
      if (usageReserved) {
        await updateReservedUsage(serviceClient, { userId, requestId, status: "failed", errorCode: "transcription_failed" });
      } else {
        await recordUsage(serviceClient, {
          userId,
          requestId,
          durationMs,
          audioSizeBytes,
          status: "failed",
          errorCode: "transcription_failed"
        });
      }
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

async function reserveTranscribeUsage(
  serviceClient: SupabaseClientLike,
  {
    userId,
    requestId,
    durationMs,
    audioSizeBytes,
    monthlySeconds,
    rateLimitPerMinute
  }: {
    userId: string;
    requestId: string;
    durationMs: number;
    audioSizeBytes: number;
    monthlySeconds: number;
    rateLimitPerMinute: number;
  }
) {
  const { data, error } = await serviceClient.rpc("reserve_transcribe_usage", {
    p_user_id: userId,
    p_request_id: requestId,
    p_provider: PROVIDER,
    p_mode: "cloud",
    p_audio_duration_ms: Math.round(durationMs),
    p_audio_size_bytes: audioSizeBytes,
    p_monthly_seconds: monthlySeconds,
    p_rate_limit_per_minute: rateLimitPerMinute
  });
  if (error) {
    console.error("Failed to reserve usage:", error);
    throw new Error("Usage reservation failed");
  }
  return typeof data === "string" && data ? data : null;
}

async function updateReservedUsage(
  serviceClient: SupabaseClientLike,
  {
    userId,
    requestId,
    status,
    errorCode
  }: {
    userId: string;
    requestId: string;
    status: "success" | "failed";
    errorCode?: string;
  }
) {
  const { error } = await serviceClient
    .from("usage_events")
    .update({ status, error_code: errorCode || null })
    .eq("user_id", userId)
    .eq("request_id", requestId);
  if (error) {
    console.error("Failed to update usage event:", error);
  }
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
