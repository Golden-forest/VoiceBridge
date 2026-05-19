import fs from "node:fs/promises";

import { convertToTencentWav } from "./audioConverter.js";
import { transcribeWithTencentCloud } from "./tencentCloudTranscriber.js";

const TENCENT_MAX_AUDIO_BYTES = 3 * 1024 * 1024;

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

    return await transcribeWithTencentCloud({
      filePath: converted.path,
      config
    });
  } finally {
    await fs.rm(converted.path, { force: true });
  }
}
