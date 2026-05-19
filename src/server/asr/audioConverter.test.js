import test from "node:test";
import assert from "node:assert/strict";

import { buildFfmpegArgs, resolveFfmpegCommand } from "./audioConverter.js";

test("resolveFfmpegCommand defaults to system ffmpeg", () => {
  assert.equal(resolveFfmpegCommand({}), "ffmpeg");
});

test("resolveFfmpegCommand allows an explicit ffmpeg path", () => {
  assert.equal(resolveFfmpegCommand({ FFMPEG_PATH: "/opt/homebrew/bin/ffmpeg" }), "/opt/homebrew/bin/ffmpeg");
});

test("buildFfmpegArgs converts input audio to 16k mono wav", () => {
  assert.deepEqual(buildFfmpegArgs("input.webm", "output.wav"), [
    "-y",
    "-i",
    "input.webm",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-acodec",
    "pcm_s16le",
    "-f",
    "wav",
    "output.wav"
  ]);
});
