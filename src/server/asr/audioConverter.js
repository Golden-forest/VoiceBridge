import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function convertToTencentWav(inputPath, tmpDir) {
  const outputPath = path.join(
    tmpDir,
    `${Date.now()}-${Math.random().toString(16).slice(2)}-16k.wav`
  );

  await execFileAsync(resolveFfmpegCommand(), buildFfmpegArgs(inputPath, outputPath), {
    windowsHide: true,
    timeout: 30_000
  }).catch((err) => {
    if (err.killed) {
      const error = new Error("ffmpeg process timed out after 30s");
      error.publicMessage = "音频转换超时，请检查音频文件格式。";
      throw error;
    }
    throw err;
  });

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
