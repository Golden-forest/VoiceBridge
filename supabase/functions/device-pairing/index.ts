import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse("method_not_allowed", "仅支持 POST 请求。", 405);
  }

  try {
    const env = getSupabaseEnv();
    const authorization = req.headers.get("Authorization") || "";
    const userClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const serviceClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) {
      return errorResponse("unauthorized", "请先登录。", 401);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return errorResponse("invalid_request", "请求内容无效。", 400);
    }

    if (body.action === "start") {
      if (!userData.user.is_anonymous) {
        // 桌面端用真实账号登录（邮箱+密码）：同账号直接自激活，无需手机扫码。
        return await selfActivate(serviceClient, userData.user.id, body.device);
      }
      return await startPairing(serviceClient, userData.user.id, body.device);
    }

    if (body.action === "status") {
      return await getPairingStatus(serviceClient, userData.user.id, body.device_id);
    }

    if (body.action === "start_additional") {
      return await startAdditionalPairing(serviceClient, userData.user.id, body.device_id);
    }

    if (body.action === "cancel_additional") {
      return await cancelAdditionalPairing(serviceClient, userData.user.id, body.device_id);
    }

    if (body.action === "claim") {
      if (userData.user.is_anonymous) {
        return errorResponse("account_required", "请先使用邮箱或 GitHub 登录手机端。", 403);
      }
      return await claimPairing(serviceClient, userData.user.id, body.pairing_token);
    }

    return errorResponse("invalid_action", "不支持的配对操作。", 400);
  } catch (error) {
    console.error("Device pairing function error:", error);
    return errorResponse("pairing_failed", "设备配对失败，请稍后重试。", 500);
  }
});

async function startPairing(
  serviceClient: ReturnType<typeof createClient>,
  runtimeUserId: string,
  rawDevice: unknown
) {
  const device = parseDevice(rawDevice);
  if (!device) {
    return errorResponse("invalid_device", "电脑设备信息无效。", 400);
  }

  const { data: existing, error: existingError } = await serviceClient
    .from("devices")
    .select("id,user_id,runtime_user_id,status")
    .eq("id", device.id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing && existing.runtime_user_id !== runtimeUserId && existing.status === "active") {
    return errorResponse("device_conflict", "该设备标识已被其他会话使用。", 409);
  }
  if (existing && existing.user_id !== runtimeUserId && existing.status === "active") {
    return errorResponse("already_paired", "这台电脑已经绑定账号。", 409);
  }

  const { error: deviceError } = await serviceClient.from("devices").upsert({
    id: device.id,
    user_id: runtimeUserId,
    runtime_user_id: runtimeUserId,
    name: device.name,
    device_type: "desktop",
    platform: device.platform,
    app_version: device.appVersion,
    status: "active",
    paired_at: null,
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  if (deviceError) throw deviceError;

  const pairingToken = createPairingToken();
  const expiresAt = await savePairingToken(serviceClient, device.id, pairingToken);

  return jsonResponse({
    ok: true,
    device: { id: device.id, name: device.name, platform: device.platform },
    pairing_token: pairingToken,
    expires_at: expiresAt
  });
}

async function getPairingStatus(
  serviceClient: ReturnType<typeof createClient>,
  runtimeUserId: string,
  rawDeviceId: unknown
) {
  if (typeof rawDeviceId !== "string" || !UUID_PATTERN.test(rawDeviceId)) {
    return errorResponse("invalid_device", "电脑设备信息无效。", 400);
  }

  const { data: device, error: deviceError } = await serviceClient
    .from("devices")
    .select("user_id,status,paired_at")
    .eq("id", rawDeviceId)
    .eq("runtime_user_id", runtimeUserId)
    .maybeSingle();
  if (deviceError) throw deviceError;
  const { data: pairing, error: pairingError } = await serviceClient
    .from("device_pairings")
    .select("claimed_at,expires_at")
    .eq("device_id", rawDeviceId)
    .maybeSingle();
  if (pairingError) throw pairingError;
  const additionalPairingPending = Boolean(
    pairing
    && !pairing.claimed_at
    && new Date(pairing.expires_at).getTime() > Date.now()
  );
  if (!device || device.status !== "active" || !device.paired_at || !device.user_id) {
    return jsonResponse({ ok: true, paired: false, plan: "free" });
  }

  const { data: profile, error: profileError } = await serviceClient
    .from("profiles")
    .select("is_admin")
    .eq("user_id", device.user_id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (profile?.is_admin) {
    return jsonResponse({ ok: true, paired: true, user_id: device.user_id, plan: "admin", additional_pairing_pending: additionalPairingPending });
  }

  const { data: subscription, error: subscriptionError } = await serviceClient
    .from("subscriptions")
    .select("plan,status")
    .eq("user_id", device.user_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (subscriptionError) throw subscriptionError;
  if (subscription?.plan === "admin") {
    return jsonResponse({ ok: true, paired: true, user_id: device.user_id, plan: "admin", additional_pairing_pending: additionalPairingPending });
  }
  if (
    subscription?.plan === "pro"
    && (subscription.status === "active" || subscription.status === "trialing")
  ) {
    return jsonResponse({ ok: true, paired: true, user_id: device.user_id, plan: "pro", additional_pairing_pending: additionalPairingPending });
  }
  return jsonResponse({ ok: true, paired: true, user_id: device.user_id, plan: "free", additional_pairing_pending: additionalPairingPending });
}

async function startAdditionalPairing(
  serviceClient: ReturnType<typeof createClient>,
  runtimeUserId: string,
  rawDeviceId: unknown
) {
  if (typeof rawDeviceId !== "string" || !UUID_PATTERN.test(rawDeviceId)) {
    return errorResponse("invalid_device", "电脑设备信息无效。", 400);
  }
  const { data: device, error: deviceError } = await serviceClient
    .from("devices")
    .select("id,name,platform,user_id,runtime_user_id,status,paired_at")
    .eq("id", rawDeviceId)
    .eq("runtime_user_id", runtimeUserId)
    .maybeSingle();
  if (deviceError) throw deviceError;
  if (!device || device.status !== "active" || !device.paired_at || !device.user_id) {
    return errorResponse("device_not_paired", "电脑端尚未绑定账号。", 409);
  }

  const pairingToken = createPairingToken();
  const expiresAt = await savePairingToken(serviceClient, device.id, pairingToken);
  return jsonResponse({
    ok: true,
    device: { id: device.id, name: device.name, platform: device.platform },
    pairing_token: pairingToken,
    expires_at: expiresAt
  });
}

async function cancelAdditionalPairing(
  serviceClient: ReturnType<typeof createClient>,
  runtimeUserId: string,
  rawDeviceId: unknown
) {
  if (typeof rawDeviceId !== "string" || !UUID_PATTERN.test(rawDeviceId)) {
    return errorResponse("invalid_device", "电脑设备信息无效。", 400);
  }
  const { data: device, error: deviceError } = await serviceClient
    .from("devices")
    .select("id")
    .eq("id", rawDeviceId)
    .eq("runtime_user_id", runtimeUserId)
    .maybeSingle();
  if (deviceError) throw deviceError;
  if (!device) return errorResponse("device_not_found", "电脑设备不存在。", 404);
  const { error } = await serviceClient
    .from("device_pairings")
    .update({ expires_at: new Date().toISOString() })
    .eq("device_id", device.id)
    .is("claimed_at", null);
  if (error) throw error;
  return jsonResponse({ ok: true });
}

// 真实账号（非匿名）请求 start：设备直接归属该账号并激活，跳过配对 token。
// LAN 会员门禁依赖桌面端登录账号，此路径保证同账号登录即上线。
async function selfActivate(
  serviceClient: ReturnType<typeof createClient>,
  userId: string,
  rawDevice: unknown
) {
  const device = parseDevice(rawDevice);
  if (!device) {
    return errorResponse("invalid_device", "电脑设备信息无效。", 400);
  }

  const { data: existing, error: existingError } = await serviceClient
    .from("devices")
    .select("id,user_id,runtime_user_id,status")
    .eq("id", device.id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing && existing.user_id !== userId && existing.status === "active") {
    return errorResponse("already_paired", "这台电脑已绑定其他账号，请先在原账号上解除绑定。", 409);
  }

  const now = new Date().toISOString();
  const { error: deviceError } = await serviceClient.from("devices").upsert({
    id: device.id,
    user_id: userId,
    runtime_user_id: userId,
    name: device.name,
    device_type: "desktop",
    platform: device.platform,
    app_version: device.appVersion,
    status: "active",
    paired_at: now,
    last_seen_at: now,
    updated_at: now
  });
  if (deviceError) throw deviceError;

  return jsonResponse({
    ok: true,
    self_activated: true,
    device: { id: device.id, name: device.name, platform: device.platform }
  });
}

async function claimPairing(
  serviceClient: ReturnType<typeof createClient>,
  userId: string,
  rawPairingToken: unknown
) {
  if (typeof rawPairingToken !== "string" || rawPairingToken.length < 32 || rawPairingToken.length > 256) {
    return errorResponse("invalid_pairing_token", "配对二维码无效。", 400);
  }

  const tokenHash = await sha256(rawPairingToken);
  const { data, error } = await serviceClient.rpc("claim_device_pairing", {
    p_token_hash: tokenHash,
    p_user_id: userId
  });
  if (error) throw error;
  const device = Array.isArray(data) ? data[0] : null;
  if (!device) {
    return errorResponse("pairing_expired", "配对二维码已过期，请在电脑端刷新。", 410);
  }

  return jsonResponse({
    ok: true,
    device: {
      id: device.device_id,
      name: device.device_name,
      platform: device.device_platform
    }
  });
}

function parseDevice(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const device = value as Record<string, unknown>;
  if (typeof device.id !== "string" || !UUID_PATTERN.test(device.id)) return null;
  if (typeof device.name !== "string" || !device.name.trim() || device.name.length > 120) return null;
  if (typeof device.platform !== "string" || !device.platform.trim() || device.platform.length > 60) return null;
  return {
    id: device.id,
    name: device.name.trim(),
    platform: device.platform.trim(),
    appVersion: typeof device.app_version === "string" ? device.app_version.slice(0, 40) : null
  };
}

function createPairingToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function savePairingToken(
  serviceClient: ReturnType<typeof createClient>,
  deviceId: string,
  pairingToken: string
) {
  const tokenHash = await sha256(pairingToken);
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  const { error } = await serviceClient.from("device_pairings").upsert({
    device_id: deviceId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    claimed_at: null,
    created_at: new Date().toISOString()
  });
  if (error) throw error;
  return expiresAt;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getSupabaseEnv() {
  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  };
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function errorResponse(code: string, message: string, status: number) {
  return jsonResponse({ ok: false, code, message }, status);
}
