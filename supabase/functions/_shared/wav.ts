export function parsePcmWavDurationMs(bytes: Uint8Array) {
  if (bytes.byteLength < 44) return null;
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") return null;
  if (readUint32Le(bytes, 4) + 8 !== bytes.byteLength) return null;

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  let hasFormat = false;
  let hasData = false;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = readUint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > bytes.byteLength) return null;

    if (chunkId === "fmt " && chunkSize >= 16) {
      if (hasFormat) return null;
      hasFormat = true;
      const audioFormat = readUint16Le(bytes, dataOffset);
      if (audioFormat !== 1) return null;
      channels = readUint16Le(bytes, dataOffset + 2);
      sampleRate = readUint32Le(bytes, dataOffset + 4);
      bitsPerSample = readUint16Le(bytes, dataOffset + 14);
      if (channels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) return null;
      if (readUint32Le(bytes, dataOffset + 8) !== 32000 || readUint16Le(bytes, dataOffset + 12) !== 2) return null;
    } else if (chunkId === "data") {
      if (!hasFormat || hasData || chunkSize % 2 !== 0) return null;
      hasData = true;
      dataBytes = chunkSize;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  if (offset !== bytes.byteLength || !hasFormat || !hasData) return null;

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
