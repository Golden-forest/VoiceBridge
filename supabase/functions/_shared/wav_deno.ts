import { assertEquals } from "jsr:@std/assert";

import { parsePcmWavDurationMs } from "./wav.ts";

Deno.test("parsePcmWavDurationMs returns duration for 16-bit PCM WAV", () => {
  assertEquals(parsePcmWavDurationMs(makePcmWav({ samples: 16000 })), 1000);
});

Deno.test("parsePcmWavDurationMs rejects non-PCM and malformed WAV bytes", () => {
  assertEquals(parsePcmWavDurationMs(new Uint8Array([1, 2, 3])), null);
  assertEquals(parsePcmWavDurationMs(makePcmWav({ audioFormat: 3, samples: 16000 })), null);
  assertEquals(parsePcmWavDurationMs(makePcmWav({ samples: 16000, truncateData: true })), null);
});

function makePcmWav({
  samples,
  audioFormat = 1,
  sampleRate = 16000,
  channels = 1,
  bitsPerSample = 16,
  truncateData = false
}: {
  samples: number;
  audioFormat?: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  truncateData?: boolean;
}) {
  const dataBytes = samples * channels * (bitsPerSample / 8);
  const bytes = new Uint8Array(44 + dataBytes - (truncateData ? 1 : 0));
  writeAscii(bytes, 0, "RIFF");
  writeUint32Le(bytes, 4, 36 + dataBytes);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  writeUint32Le(bytes, 16, 16);
  writeUint16Le(bytes, 20, audioFormat);
  writeUint16Le(bytes, 22, channels);
  writeUint32Le(bytes, 24, sampleRate);
  writeUint32Le(bytes, 28, sampleRate * channels * (bitsPerSample / 8));
  writeUint16Le(bytes, 32, channels * (bitsPerSample / 8));
  writeUint16Le(bytes, 34, bitsPerSample);
  writeAscii(bytes, 36, "data");
  writeUint32Le(bytes, 40, dataBytes);
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) {
    bytes[offset + i] = value.charCodeAt(i);
  }
}

function writeUint16Le(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32Le(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
