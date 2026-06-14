import fs from "node:fs/promises";

import { convertToTencentWav } from "./audioConverter.js";
import { transcribeWithTencentCloud } from "./tencentCloudTranscriber.js";

const TENCENT_MAX_AUDIO_BYTES = 3 * 1024 * 1024;

// Always-fillers: these are almost never meaningful suffixes in Chinese.
const ALWAYS_FILLER = "嗯呃唔噢欸诶哼嘖啧啊哦";
const ALL_FILLER = ALWAYS_FILLER;

const FILLER_RE = new RegExp(
  `[${ALL_FILLER}][,，。？！、；：\\s]*`,
  "g"
);

/**
 * Remove single-character Chinese interjections / filler words from ASR text.
 * Handles surrounding punctuation and whitespace cleanup.
 */
function removeFillerWords(text) {
  if (!text) return text;
  const cleaned = text.replace(FILLER_RE, "");
  return cleaned.trim() || "";
}

const SHORT_SEGMENT_THRESHOLD = 15;
const CLOSING_PARTICLES = new Set("吗呢啊吧呀哦啦嘛了的哈！？");

/**
 * Remove unnecessary sentence-ending punctuation caused by thinking pauses
 * in ASR output.  Handles 。, ？, and ！.
 *
 * A punctuation mark is kept only when the segment before it is long enough
 * (>= 8 chars) or ends with a sentence-closing particle, or it is the final
 * punctuation mark in the text.
 */
function cleanAsrPunctuation(text) {
  if (!text) return text;
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  // Split while preserving the delimiters so we can decide whether to keep them.
  // parts layout: [text, punct, text, punct, ..., text]
  const parts = trimmed.split(/([。？！])/);

  // Build an array of { text, punct } pairs for easier processing.
  // The last entry may have punct === null if the string doesn't end with punctuation.
  const pairs = [];
  for (let i = 0; i < parts.length; i += 2) {
    pairs.push({ text: parts[i] || "", punct: parts[i + 1] ?? null });
  }

  // Determine the index of the last punctuation mark *that sits at the very
  // end of the string* (followed only by an optional empty trailing segment).
  // A punctuation that has non-empty text after it is NOT considered "last".
  let lastPunctIdx = -1;
  for (let i = pairs.length - 1; i >= 0; i--) {
    if (pairs[i].punct !== null) {
      lastPunctIdx = i;
      break;
    }
    if (pairs[i].text.length > 0) {
      // Found non-empty trailing text before reaching a punctuation mark.
      break;
    }
  }

  // Collect output fragments.  When a punctuation is removed we carry the
  // accumulated text forward so it can be merged with the next segment.
  let carry = "";
  const result = [];

  for (let i = 0; i < pairs.length; i++) {
    const { text, punct } = pairs[i];
    const fullText = carry + text;
    carry = ""; // reset for next iteration

    if (punct === null) {
      // Trailing text without punctuation — always keep.
      result.push(fullText);
      break;
    }

    const isLast = i === lastPunctIdx;
    const lastChar = fullText.length > 0 ? fullText[fullText.length - 1] : "";
    const endsWithClosing = lastChar !== "" && CLOSING_PARTICLES.has(lastChar);
    const isLongEnough = fullText.length >= SHORT_SEGMENT_THRESHOLD;

    if (endsWithClosing || isLongEnough || isLast) {
      // Keep the punctuation.
      result.push(fullText, punct);
    } else {
      // Remove the punctuation — carry the text forward for merging.
      carry = fullText;
    }
  }

  // If there is leftover carry with nowhere to merge (shouldn't normally
  // happen since the last punct is always kept), append it.
  if (carry) result.push(carry);

  const joined = result.join("");
  return joined || trimmed;
}

export { removeFillerWords, cleanAsrPunctuation };
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
    return cleanAsrPunctuation(removeFillerWords(raw));
  } finally {
    await fs.rm(converted.path, { force: true });
  }
}
