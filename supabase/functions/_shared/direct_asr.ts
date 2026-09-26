// 直连识别（Direct ASR）共享逻辑：Edge 只做鉴权、配额预留和签名下发，
// 音频由手机直发腾讯云。此文件保持纯逻辑（依赖全部注入），
// 由 issue-asr-request / report-asr-result 两个 Edge Function 装配，并用
// node --test 直接测试（见 direct_asr.test.js）。

import { jsonResponse } from "./cors.ts";
import { ERROR_CODE_QUOTA_EXCEEDED, USAGE_PROVIDER_TENCENT_CLOUD } from "./contracts.ts";
import { createTencentFlashRecognitionRequest, type TencentAsrConfig } from "./tencent_asr.ts";

// 签名有效期（秒）：腾讯 Flash 签名本身不带过期参数，这个值只用于
// 客户端的陈旧性检查（expires_at = 签名时间戳 + 300）。
export const DIRECT_ASR_SIGNATURE_TTL_SECONDS = 300;

const PROVIDER = USAGE_PROVIDER_TENCENT_CLOUD;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DirectAsrEnv = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  jwksJson: string | null;
  tencent: TencentAsrConfig;
};

// 最小化的 service client 接口（supabase-js 的结构子集），便于测试注入。
export type DirectAsrServiceClient = {
  rpc: (fn: string, params: Record<string, unknown>) => Promise<{
    data: any;
    error: { message?: string } | null;
  }>;
  from: (table: string) => any;
};

type IssueDeps = {
  loadEnv: () => DirectAsrEnv;
  createServiceClient: () => DirectAsrServiceClient;
  /** 返回 userId；鉴权失败返回 null（内部已处理 JWKS 本地验签 + getClaims 回退）。 */
  authenticate: (authHeader: string, env: DirectAsrEnv) => Promise<string | null>;
  waitUntil?: (promise: Promise<unknown>) => void;
  signFlashRequest?: typeof createTencentFlashRecognitionRequest;
  randomUUID?: () => string;
};

export function createIssueAsrHandler(deps: IssueDeps) {
  const signFlashRequest = deps.signFlashRequest ?? createTencentFlashRecognitionRequest;
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response("ok");
    }
    if (req.method !== "POST") {
      return errorResponse("method_not_allowed", "仅支持 POST 请求。", 405);
    }

    const requestId = (deps.randomUUID ?? globalThis.crypto.randomUUID.bind(globalThis.crypto))();
    const timing = { start: Date.now(), authAt: 0, bodyAt: 0, reservedAt: 0, signAt: 0 };
    let userId = "";
    let durationMs: number | null = null;
    let audioSizeBytes: number | null = null;
    let usageReserved = false;
    let serviceClient: DirectAsrServiceClient | null = null;

    try {
      const env = deps.loadEnv();
      serviceClient = deps.createServiceClient();

      const authenticatedUserId = await deps.authenticate(req.headers.get("Authorization") || "", env) ?? "";
      if (!authenticatedUserId) {
        return errorResponse("unauthorized", "请先登录后再使用云端语音识别。", 401);
      }
      timing.authAt = Date.now();

      const body = await readJsonBody(req);
      const parsed = parseIssueBody(body);
      if (!parsed.ok) {
        return errorResponse("invalid_request", "请求参数不合法。", 400);
      }
      durationMs = parsed.durationMs;
      audioSizeBytes = parsed.audioSizeBytes;
      userId = await resolveAuthorizedUserId(serviceClient, authenticatedUserId, parsed.deviceId) ?? "";
      if (!userId) {
        return errorResponse("device_not_paired", "电脑设备尚未绑定当前账号，请重新扫码绑定。", 403);
      }
      timing.bodyAt = Date.now();

      const reservation = await reserveAndGetPlan(serviceClient, {
        userId,
        requestId,
        durationMs,
        audioSizeBytes
      });
      timing.reservedAt = Date.now();
      if (reservation.errorCode) {
        await recordUsage(serviceClient, {
          userId,
          requestId,
          durationMs,
          audioSizeBytes,
          status: "rejected",
          errorCode: reservation.errorCode
        });
        return reservationError(reservation);
      }
      usageReserved = true;

      // 只有预留成功后才签名。TENCENT_APP_ID 缺失时返回 direct_asr_unavailable，
      // 让手机端回退到走 Edge 中转的 transcribe 通道。
      if (!env.tencent.appId || !env.tencent.secretId || !env.tencent.secretKey) {
        await closeReserved(deps, serviceClient, {
          userId,
          requestId,
          status: "failed",
          errorCode: "direct_asr_unavailable"
        });
        return errorResponse("direct_asr_unavailable", "直连识别暂不可用，请使用回退通道。", 503);
      }

      const timestamp = Math.floor(Date.now() / 1000);
      // 签名只覆盖 method+host+path+query，与 body 无关，这里无需音频数据。
      const signed = await signFlashRequest({
        audioBytes: new Uint8Array(0),
        config: env.tencent,
        timestamp
      });
      timing.signAt = Date.now();
      console.info("IssueAsrRequest stage timing", {
        request_id: requestId,
        auth_ms: timing.authAt - timing.start,
        body_ms: timing.bodyAt - timing.authAt,
        reserve_rpc_ms: timing.reservedAt - timing.bodyAt,
        sign_ms: timing.signAt - timing.reservedAt,
        duration_ms: durationMs,
        audio_size_bytes: audioSizeBytes
      });

      // 密钥绝不下发：只返回签名（在 headers.Authorization 内）与公共参数。
      return jsonResponse({
        ok: true,
        request_id: requestId,
        url: signed.url,
        headers: signed.headers,
        expires_at: timestamp + DIRECT_ASR_SIGNATURE_TTL_SECONDS
      });
    } catch (error) {
      console.error("IssueAsrRequest function error:", error);
      if (userId && serviceClient) {
        if (usageReserved) {
          await closeReserved(deps, serviceClient, {
            userId,
            requestId,
            status: "failed",
            errorCode: "issue_failed"
          });
        } else {
          await recordUsage(serviceClient, {
            userId,
            requestId,
            durationMs,
            audioSizeBytes,
            status: "failed",
            errorCode: "issue_failed"
          });
        }
      }
      return errorResponse("issue_failed", "签发识别请求失败，请稍后重试。", 500);
    }
  };
}

type ReportDeps = Omit<IssueDeps, "signFlashRequest" | "randomUUID">;

export function createReportAsrHandler(deps: ReportDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response("ok");
    }
    if (req.method !== "POST") {
      return errorResponse("method_not_allowed", "仅支持 POST 请求。", 405);
    }

    try {
      const env = deps.loadEnv();
      const serviceClient = deps.createServiceClient();
      const authenticatedUserId = await deps.authenticate(req.headers.get("Authorization") || "", env) ?? "";
      if (!authenticatedUserId) {
        return errorResponse("unauthorized", "请先登录后再使用云端语音识别。", 401);
      }

      const body = await readJsonBody(req);
      const requestId = typeof body?.request_id === "string" ? body.request_id.trim() : "";
      const status = body?.status === "success" ? "success" : body?.status === "failed" ? "failed" : null;
      if (!requestId || !status) {
        return errorResponse("invalid_request", "请求参数不合法。", 400);
      }
      const deviceId = parseOptionalDeviceId(body);
      if (deviceId === false) {
        return errorResponse("invalid_request", "请求参数不合法。", 400);
      }
      const userId = await resolveAuthorizedUserId(serviceClient, authenticatedUserId, deviceId) ?? "";
      if (!userId) {
        return errorResponse("device_not_paired", "电脑设备尚未绑定当前账号，请重新扫码绑定。", 403);
      }
      const errorCode = typeof body?.error_code === "string" && body.error_code ? body.error_code : undefined;
      // 实际时长回写：预签名模式在录音开始时按上限预留，成功/失败上报时用
      // 实际录音时长结算配额（quota 只统计 success/processing 行的时长）。
      // 时长本就来自客户端上报，与原信任模型一致。缺省/非法时不改动预留值。
      const durationMs = Number(body?.duration_ms);
      const actualDurationMs = Number.isFinite(durationMs) && durationMs > 0
        ? Math.round(durationMs)
        : null;

      // 只把 status=processing 的行关掉；对已关闭的行是幂等 no-op（迟到上报不会
      // 覆盖第一次结果），并限定 user_id + request_id 防止跨用户写。
      await updateReservedUsage(serviceClient, { userId, requestId, status, errorCode, actualDurationMs });
      return jsonResponse({ ok: true });
    } catch (error) {
      console.error("ReportAsrResult function error:", error);
      return errorResponse("report_failed", "上报识别结果失败。", 500);
    }
  };
}

async function readJsonBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function parseIssueBody(body: any): { ok: false } | { ok: true; durationMs: number; audioSizeBytes: number; deviceId: string | null } {
  const durationMs = Number(body?.duration_ms);
  const audioSizeBytes = Number(body?.audio_size_bytes);
  const deviceId = parseOptionalDeviceId(body);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return { ok: false };
  if (!Number.isFinite(audioSizeBytes) || audioSizeBytes <= 0) return { ok: false };
  if (deviceId === false) return { ok: false };
  return { ok: true, durationMs, audioSizeBytes, deviceId };
}

function parseOptionalDeviceId(body: any): string | null | false {
  if (body?.device_id === undefined || body?.device_id === null || body?.device_id === "") return null;
  return typeof body.device_id === "string" && UUID_PATTERN.test(body.device_id)
    ? body.device_id
    : false;
}

/**
 * 手机云端请求没有 device_id，直接使用登录账号。桌面 LAN 请求携带 device_id，
 * 必须由服务端确认该设备仍由当前匿名运行身份持有且已完成绑定，之后才可代理到
 * 真实账号。客户端传入的套餐或 user_id 永远不参与授权。
 */
async function resolveAuthorizedUserId(
  serviceClient: DirectAsrServiceClient,
  authenticatedUserId: string,
  deviceId: string | null
): Promise<string | null> {
  if (!deviceId) return authenticatedUserId;
  const { data, error } = await serviceClient
    .from("devices")
    .select("user_id,paired_at")
    .eq("id", deviceId)
    .eq("runtime_user_id", authenticatedUserId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data?.paired_at && typeof data.user_id === "string" ? data.user_id : null;
}

async function reserveAndGetPlan(
  serviceClient: DirectAsrServiceClient,
  { userId, requestId, durationMs, audioSizeBytes }: {
    userId: string;
    requestId: string;
    durationMs: number;
    audioSizeBytes: number;
  }
) {
  const { data, error } = await serviceClient.rpc("reserve_and_get_plan", {
    p_user_id: userId,
    p_request_id: requestId,
    p_provider: PROVIDER,
    p_mode: "cloud",
    p_audio_duration_ms: Math.round(durationMs),
    p_audio_size_bytes: audioSizeBytes,
    p_cached_plan: null
  });
  if (error) {
    console.error("Failed to reserve usage:", error);
    throw new Error("Usage reservation failed");
  }
  return {
    maxAudioMs: Number(data?.max_audio_ms) || 60_000,
    errorCode: typeof data?.error_code === "string" ? data.error_code : null
  };
}

function reservationError(reservation: { errorCode: string; maxAudioMs: number }): Response {
  if (reservation.errorCode === "audio_too_long") {
    return errorResponse(
      reservation.errorCode,
      `单次录音最长支持 ${Math.ceil(reservation.maxAudioMs / 1000)} 秒。`,
      413
    );
  }
  const message = reservation.errorCode === ERROR_CODE_QUOTA_EXCEEDED
    ? "本月云端语音识别额度已用完。"
    : reservation.errorCode === "rate_limited"
      ? "请求过于频繁，请稍后再试。"
      : "云端语音识别请求已存在，请稍后再试。";
  return errorResponse(reservation.errorCode, message, 429);
}

// 与 transcribe 的 updateReservedUsage 同形；这里只关闭 RPC 创建的 processing 行
// 以实现 report-asr-result 的幂等性。
async function updateReservedUsage(
  serviceClient: DirectAsrServiceClient,
  { userId, requestId, status, errorCode, actualDurationMs }: {
    userId: string;
    requestId: string;
    status: "success" | "failed";
    errorCode?: string;
    actualDurationMs?: number | null;
  }
) {
  const cols: Record<string, unknown> = { status, error_code: errorCode || null };
  if (actualDurationMs) {
    cols.audio_duration_ms = actualDurationMs;
  }
  const { error } = await serviceClient
    .from("usage_events")
    .update(cols)
    .eq("user_id", userId)
    .eq("request_id", requestId)
    .eq("status", "processing");
  if (error) {
    console.error("Failed to update usage event:", error);
  }
}

async function closeReserved(
  deps: IssueDeps | ReportDeps,
  serviceClient: DirectAsrServiceClient,
  params: { userId: string; requestId: string; status: "success" | "failed"; errorCode?: string }
) {
  const update = updateReservedUsage(serviceClient, params);
  const waitUntil = deps.waitUntil;
  if (waitUntil) {
    waitUntil(update);
  } else {
    await update;
  }
}

async function recordUsage(
  serviceClient: DirectAsrServiceClient,
  { userId, requestId, durationMs, audioSizeBytes, status, errorCode }: {
    userId: string;
    requestId: string;
    durationMs: number | null;
    audioSizeBytes: number | null;
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
      audio_duration_ms: Number.isFinite(durationMs as number) ? Math.round(durationMs as number) : null,
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
