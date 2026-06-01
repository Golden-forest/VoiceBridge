import test from "node:test";
import assert from "node:assert/strict";
import { encodeWav16Mono } from "./wavEncoder.js";

test("encodeWav16Mono writes a 16 kHz mono 16-bit PCM WAV blob", async () => {
  const inputSampleRate = 48000;
  const samples = new Float32Array(inputSampleRate * 10);
  const blob = encodeWav16Mono(samples, inputSampleRate);
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);

  assert.equal(blob.type, "audio/wav");
  assert.equal(readString(view, 0, 4), "RIFF");
  assert.equal(readString(view, 8, 4), "WAVE");
  assert.equal(readString(view, 12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(readString(view, 36, 4), "data");
  assert.equal(view.getUint32(40, true), 320000);
  assert.equal(blob.size, 320044);
});

test("encodeWav16Mono clamps samples to signed 16-bit PCM range", async () => {
  const blob = encodeWav16Mono(new Float32Array([-2, -1, 0, 1, 2]), 16000);
  const view = new DataView(await blob.arrayBuffer());

  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), -32768);
  assert.equal(view.getInt16(48, true), 0);
  assert.equal(view.getInt16(50, true), 32767);
  assert.equal(view.getInt16(52, true), 32767);
});

function readString(view, offset, length) {
  let value = "";
  for (let i = 0; i < length; i++) {
    value += String.fromCharCode(view.getUint8(offset + i));
  }
  return value;
}
