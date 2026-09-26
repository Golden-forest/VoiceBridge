import fs from "node:fs/promises";

import { convertToTencentWav, isTencentReadyWav } from "./audioConverter.js";
import { transcribeWithTencentCloud } from "./tencentCloudTranscriber.js";
import { resolveAsrChannel, transcribeViaEdgeAsr } from "./directEdgeAsr.js";
import { removeFillerWords } from "./removeFillerWords.js";

export { removeFillerWords };

const TENCENT_MAX_AUDIO_BYTES = 3 * 1024 * 1024;


// edgeAsr（可选）：{ getAccessToken, supabaseUrl, supabaseAnonKey }。本地缺少
// 腾讯云凭证时（Electron 内嵌 LAN 服务场景），改走 Edge 逐次签名直连通道，
// 密钥永不出云端。凭证存在（.env 开发场景）时保持原本地路径。
// prefetchedIssue（可选）：录音期间预取的签名（edge 通道专用），有效则跳过
// 停止录音后的实时签发往返。
export async function transcribeAudio({ filePath, tmpDir, prefetchedIssue = null }, config, edgeAsr) {
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

  // 手机端上传的已是 16kHz/16bit/mono WAV 时跳过 ffmpeg 转换直接透传，
  // 打包版桌面 App 不再依赖 ffmpeg（transcriber 路径上的硬性外部依赖）。
  let converted;
  if (await isTencentReadyWav(filePath)) {
    const stats = await fs.stat(filePath);
    converted = { path: filePath, bytes: stats.size, passthrough: true };
  } else {
    converted = await convertToTencentWav(filePath, tmpDir);
  }
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
      raw = await transcribeViaEdgeAsr({ wavBuffer, ...edgeAsr, prefetchedIssue });
    }
    return removeFillerWords(raw);
  } finally {
    // 透传路径不删原始上传文件（upload 路由的 finally 负责清理）。
    if (!converted.passthrough) {
      await fs.rm(converted.path, { force: true });
    }
  }
}
