import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";

// 打包版桌面 App 的可选本地腾讯凭证：放到 userData 下的 voicebridge.env
//（macOS: ~/Library/Application Support/VoiceBridge Agent/voicebridge.env），
// LAN 识别即恢复本地凭证通道（resolveAsrChannel 优先本地），无需 Edge 逐次
// 签名——自用场景的全链路最快路径。分发给其他用户的安装包默认没有这个
// 文件，自动走 Edge 签名直连通道（密钥不出云端的设计不变）。
export const LOCAL_CREDENTIALS_FILENAME = "voicebridge.env";

// 只接受与识别通道相关的字符串键，其余（过滤器数值/支付/Supabase 等）一律
// 忽略——这个文件用途单一，避免它变成绕过打包配置的任意环境变量注入口。
const SECRET_ID_KEY = "TENCENT_SECRET_ID";
const SECRET_KEY_KEY = "TENCENT_SECRET_KEY";
const OPTIONAL_KEYS = {
  TENCENT_ASR_REGION: "tencentAsrRegion",
  TENCENT_ASR_ENG_SERVICE_TYPE: "tencentAsrEngServiceType"
};

/**
 * 读取并解析可选的本地识别凭证文件。
 *
 * @param {string} dir 凭证文件所在目录（Electron userData）
 * @param {Function} [readFile] 可注入的文件读取（测试用）
 * @returns {Promise<Object|null>} loadConfig 键名形状的覆盖项；
 *   文件不存在 / 缺少任一必填键时返回 null（调用方保持默认 Edge 通道）。
 */
export async function loadLocalAsrCredentials(dir, readFile = fs.readFile) {
  let raw;
  try {
    raw = await readFile(path.join(dir, LOCAL_CREDENTIALS_FILENAME), "utf8");
  } catch {
    return null; // 首次运行/未配置：正常路径，静默
  }
  try {
    return parseAsrCredentials(raw);
  } catch {
    return null; // 内容损坏：回退 Edge 通道，不阻塞 LAN 启动
  }
}

export function parseAsrCredentials(raw) {
  const parsed = parse(String(raw || ""));
  const secretId = (parsed[SECRET_ID_KEY] || "").trim();
  const secretKey = (parsed[SECRET_KEY_KEY] || "").trim();
  // 两个必填键缺一即视为未配置：半套凭证只会让识别请求在腾讯侧 401，
  // 不如直接回退 Edge 签名通道。
  if (!secretId || !secretKey) return null;

  const overrides = { tencentSecretId: secretId, tencentSecretKey: secretKey };
  for (const [envKey, configKey] of Object.entries(OPTIONAL_KEYS)) {
    const value = parsed[envKey];
    if (typeof value === "string" && value.trim() !== "") {
      overrides[configKey] = value.trim();
    }
  }
  return overrides;
}
