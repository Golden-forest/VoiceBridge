import test from "node:test";
import assert from "node:assert/strict";

import { buildPublicConfig, loadConfig, parseBoolean } from "./config.js";

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

test("loadConfig exposes cloud runtime config without service secrets", () => {
  const config = loadConfig({
    PORT: "3210",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    STRIPE_SECRET_KEY: "stripe-secret",
    VOICEBRIDGE_MODE: "cloud"
  });

  assert.equal(config.voicebridgeMode, "cloud");
  assert.equal(config.supabaseUrl, "https://example.supabase.co");
  assert.equal(config.supabaseAnonKey, "anon-key");
  assert.equal(config.supabaseServiceRoleKey, "service-role-secret");
  assert.equal(config.stripeSecretKey, "stripe-secret");
});

test("buildPublicConfig excludes service, Stripe, and Tencent secrets", () => {
  const config = loadConfig({
    VOICEBRIDGE_MODE: "cloud",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    STRIPE_SECRET_KEY: "stripe-secret",
    STRIPE_WEBHOOK_SECRET: "stripe-webhook-secret",
    TENCENT_SECRET_ID: "tencent-secret-id",
    TENCENT_SECRET_KEY: "tencent-secret-key"
  });

  const publicConfig = buildPublicConfig(config);
  const serialized = JSON.stringify(publicConfig);

  assert.deepEqual(publicConfig, {
    voicebridgeMode: "cloud",
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon-key"
  });
  assert.equal(serialized.includes("service-role-secret"), false);
  assert.equal(serialized.includes("stripe-secret"), false);
  assert.equal(serialized.includes("stripe-webhook-secret"), false);
  assert.equal(serialized.includes("tencent-secret-id"), false);
  assert.equal(serialized.includes("tencent-secret-key"), false);
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
