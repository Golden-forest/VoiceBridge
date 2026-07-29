import { createClient } from "@supabase/supabase-js";
import { t } from "./i18n/i18n.js";

const config = window.__VB_CONFIG || {};
const overlay = document.querySelector("#authOverlay");
const form = document.querySelector("#authForm");
const emailInput = document.querySelector("#authEmail");
const passwordInput = document.querySelector("#authPassword");
const submitBtn = document.querySelector("#authSubmitBtn");
const switchBtn = document.querySelector("#authSwitchBtn");
const githubBtn = document.querySelector("#authGithubBtn");
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
  if (submitBtn) submitBtn.textContent = mode === "sign-in" ? t('auth.submitLogin') : t('auth.submitSignup');
  if (switchBtn) switchBtn.textContent = mode === "sign-in" ? t('auth.switchToSignup') : t('auth.switchToLogin');
  if (modeLabel) {
    modeLabel.textContent = mode === "sign-in"
      ? t('auth.subtitleLogin')
      : t('auth.subtitleSignup');
  }
  if (passwordInput) passwordInput.autocomplete = mode === "sign-in" ? "current-password" : "new-password";
  form?.classList.toggle("is-sign-up", mode === "sign-up");
}

function emitAuthReady(session) {
  window.VoiceBridgeAuth.session = session;
  window.VoiceBridgeAuth.user = session?.user || null;
  window.dispatchEvent(new CustomEvent("voicebridge:auth", {
    detail: { session, user: session?.user || null }
  }));
}

if (!isCloudMode) {
  overlay?.classList.add("hidden");
  emitAuthReady(null);
} else if (!supabase) {
  overlay?.classList.remove("hidden");
  setMessage(t('auth.missingConfig'), true);
  emitAuthReady(null);
} else {
  const { data } = await supabase.auth.getSession();
  overlay?.classList.toggle("hidden", Boolean(data.session));
  emitAuthReady(data.session);

  supabase.auth.onAuthStateChange((event, session) => {
    overlay?.classList.toggle("hidden", Boolean(session));
    if (!session && event !== "SIGNED_OUT") {
      setMessage(t('status.sessionExpired'));
    }
    emitAuthReady(session);
  });
}

switchBtn?.addEventListener("click", () => {
  setMode(mode === "sign-in" ? "sign-up" : "sign-in");
  resendBtn?.classList.add("hidden");
});

githubBtn?.addEventListener("click", async () => {
  if (!supabase) return;
  setMessage("");
  githubBtn.disabled = true;
  try {
    const redirectTo = new URL("/", window.location.href).href;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo }
    });
    if (error) {
      setMessage(error.message, true);
      githubBtn.disabled = false;
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : t('auth.githubFailed'), true);
    githubBtn.disabled = false;
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
      setMessage(t('auth.signupSuccess'));
      resendBtn?.classList.remove("hidden");
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : t('auth.authRequestFailed'), true);
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
  if (resetEmailInput && emailInput) resetEmailInput.value = emailInput.value;
  if (modeLabel) modeLabel.textContent = t('auth.backToReset');
});

resetBackBtn?.addEventListener("click", () => {
  resetForm?.classList.add("hidden");
  form?.classList.remove("hidden");
  setMode("sign-in");
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
    if (resetInfo) resetInfo.textContent = t('auth.resetSent');
    resetBtn.textContent = t('auth.resetSentShort');
    resetBtn.disabled = true;
    setTimeout(() => {
      resetBtn.textContent = t('auth.sendResetLink');
      resetBtn.disabled = false;
    }, 5000);
  } catch (error) {
    resetBtn.disabled = false;
    setMessage(error instanceof Error ? error.message : t('auth.resetSendFailed'), true);
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
    resendBtn.textContent = t('auth.resetSentShort');
    setTimeout(() => { resendBtn.textContent = t('auth.resendVerification'); }, 3000);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : t('auth.resetSendFailed'), true);
  } finally {
    resendBtn.disabled = false;
  }
});

setMode("sign-in");
