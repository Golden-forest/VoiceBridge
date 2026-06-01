export async function createBillingSession({
  supabase = globalThis.window?.VoiceBridgeAuth?.supabase,
  functionName,
  fetch: fetchImpl = globalThis.fetch
} = {}) {
  if (!supabase) {
    throw new Error("请先登录后再管理订阅。");
  }
  if (!functionName) {
    throw new Error("缺少订阅请求配置。");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("当前浏览器无法发起订阅请求。");
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw new Error(error.message || "获取登录状态失败，请重新登录。");
  }
  const accessToken = data?.session?.access_token;
  if (!accessToken) {
    throw new Error("请先登录后再管理订阅。");
  }

  const supabaseUrl = supabase.supabaseUrl || supabase.rest?.url?.replace(/\/rest\/v1\/?$/, "");
  const anonKey = supabase.supabaseKey || supabase.headers?.apikey;
  if (!supabaseUrl || !anonKey) {
    throw new Error("缺少 Supabase 订阅配置。");
  }

  const response = await fetchImpl(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`
    }
  });
  const payload = await parseJson(response);

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || payload?.error || "订阅请求失败，请稍后重试。");
  }
  if (typeof payload.url !== "string" || !payload.url) {
    throw new Error("订阅请求未返回可用链接。");
  }

  return payload;
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
