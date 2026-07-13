export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.PORT || "3000", 10);

  return {
    port: Number.isFinite(port) ? port : 3000,
    asrProvider: env.ASR_PROVIDER || "tencent",
    tencentSecretId: env.TENCENT_SECRET_ID || "",
    tencentSecretKey: env.TENCENT_SECRET_KEY || "",
    tencentAsrRegion: env.TENCENT_ASR_REGION || "ap-shanghai",
    tencentAsrEngServiceType: env.TENCENT_ASR_ENG_SERVICE_TYPE || "16k_zh",
    tencentAsrVoiceFormat: "wav",
    // ASR 过滤参数（智能标点策略默认值）
    tencentAsrFilterDirty: parseAsrFilter(env.TENCENT_ASR_FILTER_DIRTY, 0),
    tencentAsrFilterModal: parseAsrFilter(env.TENCENT_ASR_FILTER_MODAL, 1),
    tencentAsrFilterPunc: parseAsrFilter(env.TENCENT_ASR_FILTER_PUNC, 0),
    tencentAsrConvertNumMode: parseAsrFilter(env.TENCENT_ASR_CONVERT_NUM_MODE, 1),
    autoPaste: parseBoolean(env.AUTO_PASTE, true)
  };
}

function parseAsrFilter(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}
