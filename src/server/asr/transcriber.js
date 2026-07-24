import fs from "node:fs/promises";

import { convertToTencentWav } from "./audioConverter.js";
import { transcribeWithTencentCloud } from "./tencentCloudTranscriber.js";

const TENCENT_MAX_AUDIO_BYTES = 3 * 1024 * 1024;

// 独立单字语气词（腾讯云 FilterModal=1 已部分过滤，这里做二次清理）
const FILLER_CHARS = "嗯呃唔噢欸诶哼嘖啧";
const FILLER_RE = new RegExp(`[${FILLER_CHARS}]`, "g");

/**
 * 清理独立单字语气词（嗯/呃/唔等）。
 * 信任腾讯云 ASR 返回的标点，不做任何标点增删。
 */
function removeFillerWords(text) {
  if (!text) return text;
  return text.replace(FILLER_RE, "").trim() || "";
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
