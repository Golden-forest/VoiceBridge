import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  LOCAL_CREDENTIALS_FILENAME,
  loadLocalAsrCredentials,
  parseAsrCredentials
} from "./asrCredentials.js";

function fakeReadFile(files) {
  return async (filePath) => {
    const name = path.basename(filePath);
    if (!(name in files)) {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    }
    return files[name];
  };
}

test("parseAsrCredentials extracts required secrets plus optional string keys", () => {
  const overrides = parseAsrCredentials(`
# 注释行
TENCENT_SECRET_ID=secret-id-1
TENCENT_SECRET_KEY="secret-key-1"
TENCENT_ASR_REGION=ap-shanghai
TENCENT_ASR_ENG_SERVICE_TYPE=16k_zh
STRIPE_SECRET_KEY=sk_should_be_ignored
`);
  assert.deepEqual(overrides, {
    tencentSecretId: "secret-id-1",
    tencentSecretKey: "secret-key-1",
    tencentAsrRegion: "ap-shanghai",
    tencentAsrEngServiceType: "16k_zh"
  });
});

test("parseAsrCredentials requires both secret id and key", () => {
  assert.equal(parseAsrCredentials("TENCENT_SECRET_ID=only-id"), null);
  assert.equal(parseAsrCredentials("TENCENT_SECRET_KEY=only-key"), null);
  assert.equal(parseAsrCredentials(""), null);
  assert.equal(parseAsrCredentials(null), null);
});

test("loadLocalAsrCredentials reads the env file from the given directory", async () => {
  const readFile = fakeReadFile({
    [LOCAL_CREDENTIALS_FILENAME]: "TENCENT_SECRET_ID=id\nTENCENT_SECRET_KEY=key"
  });
  const overrides = await loadLocalAsrCredentials("/userData", readFile);
  assert.deepEqual(overrides, { tencentSecretId: "id", tencentSecretKey: "key" });
});

test("loadLocalAsrCredentials returns null when the file is missing or incomplete", async () => {
  assert.equal(await loadLocalAsrCredentials("/userData", fakeReadFile({})), null);
  const incomplete = fakeReadFile({
    [LOCAL_CREDENTIALS_FILENAME]: "TENCENT_SECRET_ID=id-without-key"
  });
  assert.equal(await loadLocalAsrCredentials("/userData", incomplete), null);
});
