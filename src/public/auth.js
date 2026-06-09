import { createClient } from "@supabase/supabase-js";

const config = window.__VB_CONFIG || {};
const overlay = document.querySelector("#authOverlay");
const form = document.querySelector("#authForm");
const emailInput = document.querySelector("#authEmail");
const passwordInput = document.querySelector("#authPassword");
const submitBtn = document.querySelector("#authSubmitBtn");
const switchBtn = document.querySelector("#authSwitchBtn");
const logoutBtn = document.querySelector("#authLogoutButton");
const modeLabel = document.querySelector("#authModeLabel");
const messageEl = document.querySelector("#authMessage");
const isCloudMode = config.voicebridgeMode === "cloud";

let mode = "sign-in";

export const supabase = config.supabaseUrl && config.supabaseAnonKey
  ? createClient(config.supabaseUrl, config.supabaseAnonKey)
  : null;

window.VoiceBridgeAuth = {
  supabase,
  session: null,
  user: null,
  signOut: async () => supabase?.auth.signOut()
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
  logoutBtn?.classList.toggle("hidden", !isCloudMode || !session);
  window.dispatchEvent(new CustomEvent("voicebridge:auth", {
    detail: { session, user: session?.user || null }
  }));
}

if (!isCloudMode) {
  overlay?.classList.add("hidden");
  emitAuthReady(null);
} else if (!supabase) {
  overlay?.classList.remove("hidden");
  setMessage("缺少 Supabase 配置，请检查 /config.js。", true);
  emitAuthReady(null);
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

logoutBtn?.addEventListener("click", async () => {
  if (!supabase) return;
  logoutBtn.disabled = true;
  try {
    await supabase.auth.signOut();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "退出登录失败，请稍后再试。", true);
  } finally {
    logoutBtn.disabled = false;
  }
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
      resendBtn?.classList.remove("hidden");
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "认证请求失败，请稍后再试。", true);
  } finally {
    submitBtn.disabled = false;
  }
});

// === 密码重置 ===
const forgotBtn = document.querySelector("#authForgotBtn");
const resetForm = document.querySelector("#authResetForm");
const resetEmailInput = document.querySelector("#authResetEmail");
const resetBtn = document.querySelector("#authResetBtn");
const resetBackBtn = document.querySelector("#authResetBackBtn");
const resendBtn = document.querySelector("#authResendBtn");
const resetInfo = document.querySelector(".auth-reset-info");

forgotBtn?.addEventListener("click", () => {
  form?.classList.add("hidden");
  resetForm?.classList.remove("hidden");
  forgotBtn.classList.add("hidden");
  switchBtn?.classList.add("hidden");
  submitBtn?.classList.add("hidden");
  if (resetEmailInput && emailInput) resetEmailInput.value = emailInput.value;
  if (modeLabel) modeLabel.textContent = "重置密码";
});

resetBackBtn?.addEventListener("click", () => {
  resetForm?.classList.add("hidden");
  form?.classList.remove("hidden");
  forgotBtn?.classList.remove("hidden");
  switchBtn?.classList.remove("hidden");
  submitBtn?.classList.remove("hidden");
  if (modeLabel) modeLabel.textContent = "登录以连接你的设备";
});

resetBtn?.addEventListener("click", async () => {
  if (!supabase || !resetEmailInput) return;
  const email = resetEmailInput.value.trim();
  if (!email) return;
  resetBtn.disabled = true;
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) {
      setMessage(error.message, true);
      return;
    }
    if (resetInfo) resetInfo.textContent = "重置链接已发送到您的邮箱。";
    resetBtn.textContent = "已发送";
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "发送失败，请稍后重试。", true);
  } finally {
    resetBtn.disabled = false;
  }
});

// === 邮箱验证重发 ===
resendBtn?.addEventListener("click", async () => {
  if (!supabase || !emailInput) return;
  const email = emailInput.value.trim();
  if (!email) return;
  resendBtn.disabled = true;
  try {
    const { error } = await supabase.auth.resend({ type: "signup", email });
    if (error) {
      setMessage(error.message, true);
      return;
    }
    resendBtn.textContent = "已发送";
    setTimeout(() => { resendBtn.textContent = "重新发送验证邮件"; }, 3000);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "发送失败，请稍后重试。", true);
  } finally {
    resendBtn.disabled = false;
  }
});

setMode("sign-in");
