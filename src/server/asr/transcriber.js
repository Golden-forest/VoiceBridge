import fs from "node:fs/promises";

import { convertToTencentWav } from "./audioConverter.js";
import { transcribeWithTencentCloud } from "./tencentCloudTranscriber.js";
import { resolveAsrChannel, transcribeViaEdgeAsr } from "./directEdgeAsr.js";
import { removeFillerWords } from "./removeFillerWords.js";

export { removeFillerWords };

const TENCENT_MAX_AUDIO_BYTES = 3 * 1024 * 1024;


// edgeAsr（可选）：{ getAccessToken, supabaseUrl, supabaseAnonKey }。本地缺少
// 腾讯云凭证时（Electron 内嵌 LAN 服务场景），改走 Edge 逐次签名直连通道，
// 密钥永不出云端。凭证存在（.env 开发场景）时保持原本地路径。
export async function transcribeAudio({ filePath, tmpDir }, config, edgeAsr) {
  if (config.asrProvider !== "tencent") {
    const error = new Error(`Unsupported ASR provider: ${config.asrProvider}`);
    error.statusCode = 500;
    error.publicMessage = `当前只启用了腾讯云 ASR，暂不支持 ${config.asrProvider}。`;
    throw error;
  }

  const channel = resolveAsrChannel(config, edgeAsr);
  if (channel === "none") {
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

    let raw;
    if (channel === "local") {
      raw = await transcribeWithTencentCloud({
        filePath: converted.path,
        config
      });
    } else {
      const wavBuffer = await fs.readFile(converted.path);
      raw = await transcribeViaEdgeAsr({ wavBuffer, ...edgeAsr });
    }
    return removeFillerWords(raw);
  } finally {
    await fs.rm(converted.path, { force: true });
  }
}
