import fs from "node:fs/promises";

import { convertToTencentWav } from "./audioConverter.js";
import { transcribeWithTencentCloud } from "./tencentCloudTranscriber.js";

const TENCENT_MAX_AUDIO_BYTES = 3 * 1024 * 1024;

// 独立语气词清理（与 Edge Function supabase/functions/_shared/tencent_asr.ts 共用同一份契约）。
// 规则：
//   1. 标点/空白两侧的 filler 被删除（最常见模式）
//   2. 全 filler 行清空
//   3. 行首/行尾连续重复 3+ 次的 filler 被删除（区分"嗯嗯嗯你好" vs "哼唱"/"啧啧称奇"）
//   4. 不删除汉字之间的 filler（保护"哼唱"、"啧啧称奇"等正常词）
const FILLER_CLASS = "[嗯呃唔噢欸诶哼嘖啧]";
const BOUNDARY = "[\\s，,。.!！？?、；;：:]";
const FILLER_BEFORE_BOUNDARY = new RegExp(`${FILLER_CLASS}+(${BOUNDARY})`, "gu");
const FILLER_AFTER_BOUNDARY = new RegExp(`(${BOUNDARY})${FILLER_CLASS}+`, "gu");
const ALL_FILLER = new RegExp(`^${FILLER_CLASS}+$`, "u");
const LEADING_FILLER_3PLUS = new RegExp(`^(${FILLER_CLASS})\\1{2,}`, "u");
const TRAILING_FILLER_3PLUS = new RegExp(`(${FILLER_CLASS})\\1{2,}$`, "u");

/**
 * 清理独立语气词（嗯/呃/唔等）。
 * 与 Edge Function 端的 removeFillerWords 保持字节级一致。
 */
function removeFillerWords(text) {
  if (!text) return text;

  let r = text;
  r = r.replace(FILLER_AFTER_BOUNDARY, "$1");
  r = r.replace(FILLER_BEFORE_BOUNDARY, "$1");
  if (ALL_FILLER.test(r.trim())) return "";
  r = r.replace(LEADING_FILLER_3PLUS, "");
  r = r.replace(TRAILING_FILLER_3PLUS, "");
  r = r
    .replace(/([，,。.!！？?、；;：:])\1+/gu, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，,。.!！？?、；;：:])/gu, "$1")
    .replace(/^[\s，,。.!！？?、；;：:]+/u, "")
    .trim();
  return r || "";
}

export { removeFillerWords };

export async function transcribeAudio({ filePath, tmpDir }, config) {
  if (config.asrProvider !== "tencent") {
    const error = new Error(`Unsupported ASR provider: ${config.asrProvider}`);
    error.statusCode = 500;
    error.publicMessage = `当前只启用了腾讯云 ASR，暂不支持 ${config.asrProvider}。`;
    throw error;
  }

  if (!config.tencentSecretId || !config.tencentSecretKey) {
    const error = new Error("Tencent Cloud credentials are not configured");
    error.statusCode = 500;
    error.publicMessage = "电脑端缺少腾讯云 SecretId 或 SecretKey，请先配置 .env。";
    throw error;
  }

  const converted = await convertToTencentWav(filePath, tmpDir);
  try {
    if (converted.bytes > TENCENT_MAX_AUDIO_BYTES) {
      const error = new Error(`Converted audio is too large: ${converted.bytes} bytes`);
      error.statusCode = 400;
      error.publicMessage = "录音太长，腾讯云一句话识别当前只适合 60 秒以内短音频。";
      throw error;
    }

    const raw = await transcribeWithTencentCloud({
      filePath: converted.path,
      config
    });
    return removeFillerWords(raw);
  } finally {
    await fs.rm(converted.path, { force: true });
  }
}
