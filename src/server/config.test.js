import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, parseBoolean } from "./config.js";

test("loadConfig applies safe MVP defaults", () => {
  const config = loadConfig({});

  assert.equal(config.port, 3000);
  assert.equal(config.asrProvider, "tencent");
  assert.equal(config.tencentSecretId, "");
  assert.equal(config.tencentSecretKey, "");
  assert.equal(config.tencentAsrRegion, "ap-shanghai");
  assert.equal(config.tencentAsrEngServiceType, "16k_zh");
  assert.equal(config.tencentAsrVoiceFormat, "wav");
  assert.equal(config.autoPaste, true);
});

test("loadConfig reads environment overrides", () => {
  const config = loadConfig({
    PORT: "3999",
    ASR_PROVIDER: "tencent",
    TENCENT_SECRET_ID: "secret-id",
    TENCENT_SECRET_KEY: "secret-key",
    TENCENT_ASR_REGION: "ap-guangzhou",
    TENCENT_ASR_ENG_SERVICE_TYPE: "16k_zh-PY",
    AUTO_PASTE: "false"
  });

  assert.equal(config.port, 3999);
  assert.equal(config.asrProvider, "tencent");
  assert.equal(config.tencentSecretId, "secret-id");
  assert.equal(config.tencentSecretKey, "secret-key");
  assert.equal(config.tencentAsrRegion, "ap-guangzhou");
  assert.equal(config.tencentAsrEngServiceType, "16k_zh-PY");
  assert.equal(config.autoPaste, false);
});

test("parseBoolean handles common form and env values", () => {
  assert.equal(parseBoolean("true", false), true);
  assert.equal(parseBoolean("1", false), true);
  assert.equal(parseBoolean("on", false), true);
  assert.equal(parseBoolean("false", true), false);
  assert.equal(parseBoolean("0", true), false);
  assert.equal(parseBoolean("off", true), false);
  assert.equal(parseBoolean(undefined, true), true);
});
