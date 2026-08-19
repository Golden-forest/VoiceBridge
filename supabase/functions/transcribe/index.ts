import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { ERROR_CODE_QUOTA_EXCEEDED, USAGE_PROVIDER_TENCENT_CLOUD } from "../_shared/contracts.ts";
import { verifySupabaseJwt } from "../_shared/local_jwt.ts";
import type { PlanName } from "../_shared/plan_limits.ts";
import { transcribeTencentWav } from "../_shared/tencent_asr.ts";
import { parsePcmWavDurationMs } from "../_shared/wav.ts";

const PROVIDER = USAGE_PROVIDER_TENCENT_CLOUD;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
type SupabaseClientLike = ReturnType<typeof createClient<any, "public", any>>;
const PLAN_CACHE_TTL_MS = 60_000;
const planCache = new Map<string, { plan: PlanName; expiresAt: number }>();
// 模块级复用：客户端创建一次，跨请求共享连接，避免每次请求重建的冷启动开销。
let cachedServiceClient: SupabaseClientLike | null = null;
declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse("method_not_allowed", "仅支持 POST 请求。", 405);
  }

  const requestId = crypto.randomUUID();
  const timing = { start: Date.now(), authAt: 0, formDataAt: 0, reservedAt: 0, asrAt: 0 };
  let userId = "";
  let durationMs: number | null = null;
  let audioSizeBytes = 0;
  let serviceClient: SupabaseClientLike | null = null;
  let usageReserved = false;

  try {
    const env = getSupabaseEnv();
    const authHeader = req.headers.get("Authorization") || "";
    serviceClient = cachedServiceClient ??= createClient(env.supabaseUrl, env.supabaseServiceRoleKey);

    const accessToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!accessToken) {
      return errorResponse("unauthorized", "请先登录后再使用云端语音识别。", 401);
    }
    // 本地验签（SUPABASE_JWKS 是平台默认注入的 secret）：
    // 替代 getClaims 的 300-400ms 网络往返。旧项目若仍用 HS256 对称签名
    // （JWKS 无法本地验证），回退到 getClaims 网络验签。
    const jwksJson = Deno.env.get("SUPABASE_JWKS");
    const issuer = `${env.supabaseUrl}/auth/v1`;
    let claims = jwksJson
      ? await verifySupabaseJwt(accessToken, { jwksJson, issuer }).catch(() => null)
      : null;
    if (!claims?.sub) {
      const authClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false
        }
      });
      const { data, error } = await authClient.auth.getClaims(accessToken);
      const subject = data?.claims?.sub;
      if (error || typeof subject !== "string" || !subject) {
        return errorResponse("unauthorized", "请先登录后再使用云端语音识别。", 401);
      }
      claims = { sub: subject, exp: 0 };
    }
    userId = claims.sub;
    timing.authAt = Date.now();

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
    timing.formDataAt = Date.now();

    const cachedPlan = getCachedPlan(userId);

    const reservation = await reserveAndGetPlan(serviceClient, {
      userId,
      requestId,
      durationMs,
      audioSizeBytes,
      cachedPlan
    });
    planCache.set(userId, {
      plan: reservation.plan,
      expiresAt: Date.now() + PLAN_CACHE_TTL_MS
    });
    const reservationError = reservation.errorCode;
    if (reservationError) {
      await recordUsage(serviceClient, { userId, requestId, durationMs, audioSizeBytes, status: "rejected", errorCode: reservationError });
      if (reservationError === "audio_too_long") {
        return errorResponse(
          reservationError,
          `单次录音最长支持 ${Math.ceil(reservation.maxAudioMs / 1000)} 秒。`,
          413
        );
      }
      const message = reservationError === ERROR_CODE_QUOTA_EXCEEDED
        ? "本月云端语音识别额度已用完。"
        : reservationError === "rate_limited"
          ? "请求过于频繁，请稍后再试。"
          : "云端语音识别请求已存在，请稍后再试。";
      return errorResponse(reservationError, message, 429);
    }
    usageReserved = true;
    timing.reservedAt = Date.now();

    const tencentEnv = getTencentEnv();
    const text = await transcribeTencentWav({
      audioBytes,
      requestId,
      config: {
        secretId: tencentEnv.secretId,
        secretKey: tencentEnv.secretKey,
        appId: tencentEnv.appId,
        region: tencentEnv.region,
        engServiceType: tencentEnv.engServiceType
      }
    });
    timing.asrAt = Date.now();
    console.info("Transcribe stage timing", {
      request_id: requestId,
      auth_ms: timing.authAt - timing.start,
      form_data_ms: timing.formDataAt - timing.authAt,
      reserve_rpc_ms: timing.reservedAt - timing.formDataAt,
      asr_ms: timing.asrAt - timing.reservedAt,
      audio_size_bytes: audioSizeBytes,
      duration_ms: durationMs
    });

    EdgeRuntime.waitUntil(updateReservedUsage(serviceClient, {
      userId,
      requestId,
      status: "success"
    }));
    return jsonResponse({ ok: true, request_id: requestId, text });
  } catch (error) {
    console.error("Transcribe function error:", error);
    if (userId && serviceClient) {
      if (usageReserved) {
        EdgeRuntime.waitUntil(updateReservedUsage(serviceClient, { userId, requestId, status: "failed", errorCode: "transcription_failed" }));
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

function getSupabaseEnv() {
  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  };
}

function getTencentEnv() {
  return {
    secretId: requireEnv("TENCENT_SECRET_ID"),
    secretKey: requireEnv("TENCENT_SECRET_KEY"),
    appId: Deno.env.get("TENCENT_APP_ID") || undefined,
    region: Deno.env.get("TENCENT_ASR_REGION") || "ap-shanghai",
    engServiceType: Deno.env.get("TENCENT_ASR_ENG_SERVICE_TYPE") || "16k_zh"
  };
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function reserveAndGetPlan(
  serviceClient: SupabaseClientLike,
  {
    userId,
    requestId,
    durationMs,
    audioSizeBytes,
    cachedPlan
  }: {
    userId: string;
    requestId: string;
    durationMs: number;
    audioSizeBytes: number;
    cachedPlan: PlanName | null;
  }
) {
  const { data, error } = await serviceClient.rpc("reserve_and_get_plan", {
    p_user_id: userId,
    p_request_id: requestId,
    p_provider: PROVIDER,
    p_mode: "cloud",
    p_audio_duration_ms: Math.round(durationMs),
    p_audio_size_bytes: audioSizeBytes,
    p_cached_plan: cachedPlan
  });
  if (error) {
    console.error("Failed to reserve usage:", error);
    throw new Error("Usage reservation failed");
  }
  const plan: PlanName =
    data?.plan === "admin" ? "admin" :
    data?.plan === "pro" ? "pro" : "free";
  return {
    plan,
    maxAudioMs: Number(data?.max_audio_ms) || 60_000,
    errorCode: typeof data?.error_code === "string" ? data.error_code : null
  };
}

function getCachedPlan(userId: string): PlanName | null {
  const cached = planCache.get(userId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    planCache.delete(userId);
    return null;
  }
  return cached.plan;
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
