import { createClient } from "@supabase/supabase-js";

const config = window.__VB_CONFIG || {};
const overlay = document.querySelector("#authOverlay");
const form = document.querySelector("#authForm");
const emailInput = document.querySelector("#authEmail");
const passwordInput = document.querySelector("#authPassword");
const submitBtn = document.querySelector("#authSubmitBtn");
const switchBtn = document.querySelector("#authSwitchBtn");
const modeLabel = document.querySelector("#authModeLabel");
const messageEl = document.querySelector("#authMessage");

let mode = "sign-in";

export const supabase = config.supabaseUrl && config.supabaseAnonKey
  ? createClient(config.supabaseUrl, config.supabaseAnonKey)
  : null;

window.VoiceBridgeAuth = {
  supabase,
  session: null,
  user: null
};

function setMessage(message, isError = false) {
  if (!messageEl) return;
  messageEl.textContent = message;
  messageEl.classList.toggle("error", isError);
}

function setMode(nextMode) {
  mode = nextMode;
  if (submitBtn) submitBtn.textContent = mode === "sign-in" ? "登录" : "注册";
  if (switchBtn) switchBtn.textContent = mode === "sign-in" ? "创建账号" : "已有账号，去登录";
  if (modeLabel) modeLabel.textContent = mode === "sign-in" ? "登录以连接你的设备" : "创建账号后开始使用";
  if (passwordInput) passwordInput.autocomplete = mode === "sign-in" ? "current-password" : "new-password";
}

function emitAuthReady(session) {
  window.VoiceBridgeAuth.session = session;
  window.VoiceBridgeAuth.user = session?.user || null;
  window.dispatchEvent(new CustomEvent("voicebridge:auth", {
    detail: { session, user: session?.user || null }
  }));
}

if (!supabase) {
  overlay?.classList.remove("hidden");
  setMessage("缺少 Supabase 配置，请检查 /config.js。", true);
} else {
  const { data } = await supabase.auth.getSession();
  overlay?.classList.toggle("hidden", Boolean(data.session));
  emitAuthReady(data.session);

  supabase.auth.onAuthStateChange((_event, session) => {
    overlay?.classList.toggle("hidden", Boolean(session));
    emitAuthReady(session);
  });
}

switchBtn?.addEventListener("click", () => {
  setMode(mode === "sign-in" ? "sign-up" : "sign-in");
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabase || !emailInput || !passwordInput || !submitBtn) return;
  setMessage("");
  submitBtn.disabled = true;
  try {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const result = mode === "sign-in"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    if (result.error) {
      setMessage(result.error.message, true);
      return;
    }
    if (mode === "sign-up" && !result.data.session) {
      setMessage("注册成功，请检查邮箱完成验证。");
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "认证请求失败，请稍后再试。", true);
  } finally {
    submitBtn.disabled = false;
  }
});

setMode("sign-in");
