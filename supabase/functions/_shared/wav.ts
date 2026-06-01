export function parsePcmWavDurationMs(bytes: Uint8Array) {
  if (bytes.byteLength < 44) return null;
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") return null;

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = readUint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > bytes.byteLength) return null;

    if (chunkId === "fmt " && chunkSize >= 16) {
      const audioFormat = readUint16Le(bytes, dataOffset);
      if (audioFormat !== 1) return null;
      channels = readUint16Le(bytes, dataOffset + 2);
      sampleRate = readUint32Le(bytes, dataOffset + 4);
      bitsPerSample = readUint16Le(bytes, dataOffset + 14);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!bytesPerSecond || !dataBytes) return null;
  return Math.round((dataBytes / bytesPerSecond) * 1000);
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint16Le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32Le(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}
