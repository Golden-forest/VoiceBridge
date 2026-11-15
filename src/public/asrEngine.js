// 识别引擎偏好（App 内自选）：空串 = 跟随服务端默认；localStorage 持久化，
// 云端与局域网上传共用同一份选择。
const STORAGE_KEY = "vb:asr-engine";

export const ASR_ENGINES = [
  { value: "", labelKey: "account.engineDefault" },
  { value: "tencent", labelKey: "account.engineTencent" },
  { value: "qwen", labelKey: "account.engineQwen" }
];

const VALID = new Set(ASR_ENGINES.map((engine) => engine.value));

export function getPreferredAsrEngine(storage) {
  try {
    const value = storage.getItem(STORAGE_KEY);
    return VALID.has(value) ? value : "";
  } catch {
    return "";
  }
}

export function setPreferredAsrEngine(storage, value) {
  if (!VALID.has(value)) {
    throw new Error(`不支持的识别引擎：${value}`);
  }
  try {
    if (value) storage.setItem(STORAGE_KEY, value);
    else storage.removeItem(STORAGE_KEY);
  } catch { /* 隐私模式等存储不可用时静默降级为跟随默认 */ }
}
