import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// GUI 打包版 App 的 PATH 不含 /opt/homebrew/bin 等包管理器路径，
// "ffmpeg" 裸命令 ENOENT 时依次尝试常见绝对路径。
const FFMPEG_FALLBACK_PATHS = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

export async function convertToTencentWav(inputPath, tmpDir, env = process.env) {
  const outputPath = path.join(
    tmpDir,
    `${Date.now()}-${Math.random().toString(16).slice(2)}-16k.wav`
  );

  let lastError = null;
  for (const command of resolveFfmpegCandidates(env)) {
    try {
      await execFileAsync(command, buildFfmpegArgs(inputPath, outputPath), {
        windowsHide: true,
        timeout: 30_000
      });
      lastError = null;
      break;
    } catch (err) {
      if (err.killed) {
        const error = new Error("ffmpeg process timed out after 30s");
        error.publicMessage = "音频转换超时，请检查音频文件格式。";
        throw error;
      }
      if (err.code !== "ENOENT") throw err;
      lastError = err;
    }
  }
  if (lastError) {
    const error = new Error("ffmpeg is not available");
    error.statusCode = 500;
    error.publicMessage = "电脑端缺少可用的 ffmpeg，请安装 ffmpeg（brew install ffmpeg）或设置 FFMPEG_PATH 环境变量。";
    throw error;
  }

  const stats = await fs.stat(outputPath);
  return {
    path: outputPath,
    bytes: stats.size,
    voiceFormat: "wav"
  };
}

export function resolveFfmpegCommand(env = process.env) {
  return env.FFMPEG_PATH || "ffmpeg";
}

export function resolveFfmpegCandidates(env = process.env) {
  return env.FFMPEG_PATH ? [env.FFMPEG_PATH] : ["ffmpeg", ...FFMPEG_FALLBACK_PATHS];
}

/**
 * 判断文件是否已是腾讯云要求的 16kHz/16bit/单声道 PCM WAV（手机端
 * wavEncoder 上传的即此格式）。命中则无需 ffmpeg 转换，直接透传。
 */
export async function isTencentReadyWav(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(44), 0, 44, 0);
    if (bytesRead < 44) return false;
    return buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WAVE" &&
      buffer.toString("ascii", 12, 16) === "fmt " &&
      buffer.readUInt16LE(20) === 1 && // PCM
      buffer.readUInt16LE(22) === 1 && // mono
      buffer.readUInt32LE(24) === 16000 &&
      buffer.readUInt16LE(34) === 16 &&
      buffer.toString("ascii", 36, 40) === "data";
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function buildFfmpegArgs(inputPath, outputPath) {
  return [
    "-y",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-acodec",
    "pcm_s16le",
    "-f",
    "wav",
    outputPath
  ];
}
