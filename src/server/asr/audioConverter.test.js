import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildFfmpegArgs,
  convertToTencentWav,
  isTencentReadyWav,
  resolveFfmpegCandidates,
  resolveFfmpegCommand
} from "./audioConverter.js";

async function writeTempFile(name, buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vb-audio-"));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

function wavHeader({ format = 1, channels = 1, sampleRate = 16000, bits = 16 } = {}) {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(format, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  buffer.writeUInt16LE(channels * bits / 8, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(0, 40);
  return buffer;
}

test("resolveFfmpegCommand defaults to system ffmpeg", () => {
  assert.equal(resolveFfmpegCommand({}), "ffmpeg");
});

test("resolveFfmpegCommand allows an explicit ffmpeg path", () => {
  assert.equal(resolveFfmpegCommand({ FFMPEG_PATH: "/opt/homebrew/bin/ffmpeg" }), "/opt/homebrew/bin/ffmpeg");
});

test("resolveFfmpegCandidates puts FFMPEG_PATH first when set", () => {
  assert.deepEqual(resolveFfmpegCandidates({ FFMPEG_PATH: "/custom/ffmpeg" }), ["/custom/ffmpeg"]);
});

test("resolveFfmpegCandidates falls back to common absolute paths", () => {
  const candidates = resolveFfmpegCandidates({});
  assert.equal(candidates[0], "ffmpeg");
  assert.ok(candidates.includes("/opt/homebrew/bin/ffmpeg"));
  assert.ok(candidates.includes("/usr/local/bin/ffmpeg"));
});

test("isTencentReadyWav accepts phone-uploaded 16k mono pcm wav", async () => {
  const filePath = await writeTempFile("ready.wav", wavHeader());
  assert.equal(await isTencentReadyWav(filePath), true);
});

test("isTencentReadyWav rejects non-wav and non-conforming wav", async () => {
  assert.equal(await isTencentReadyWav(await writeTempFile("a.webm", Buffer.from("webm-bytes"))), false);
  assert.equal(await isTencentReadyWav(await writeTempFile("a.wav", wavHeader({ sampleRate: 48000 }))), false);
  assert.equal(await isTencentReadyWav(await writeTempFile("a.wav", wavHeader({ channels: 2 }))), false);
  assert.equal(await isTencentReadyWav(await writeTempFile("a.wav", wavHeader({ bits: 8 }))), false);
  assert.equal(await isTencentReadyWav(await writeTempFile("a.wav", wavHeader({ format: 3 }))), false);
});

test("convertToTencentWav reports a clear message when ffmpeg is missing", async () => {
  const input = await writeTempFile("a.webm", Buffer.from("webm-bytes"));
  await assert.rejects(
    () => convertToTencentWav(input, path.dirname(input), { FFMPEG_PATH: "/nonexistent/ffmpeg" }),
    (error) => {
      assert.match(error.publicMessage, /ffmpeg/);
      return true;
    }
  );
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
