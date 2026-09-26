import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const mobileRoot = new URL("../", import.meta.url);

test("mobile bundle starts the VoiceBridge app from local packaged assets", async () => {
  const [html, config, appJs] = await Promise.all([
    readFile(new URL("www/index.html", mobileRoot), "utf8"),
    readFile(new URL("www/config.js", mobileRoot), "utf8"),
    readFile(new URL("www/app.js", mobileRoot), "utf8")
  ]);
  assert.match(html, /<script src="\/vendor\/supabase\.js"><\/script>/);
  assert.doesNotMatch(html, /esm\.sh/);
  assert.match(config, /nativeApp:\s*true/);
  assert.match(config, /voicebridgeMode:\s*"cloud"/);
  assert.match(appJs, /voicebridge_last_cloud_desktop_id/);
  assert.match(appJs, /cloudRealtime\?\.reconnectNow\(\)/);
  assert.match(html, /id="nativePairButton"/);
  assert.match(appJs, /CapacitorBarcodeScanner/);
  assert.match(appJs, /url\.protocol !== "voicebridge:"/);
  assert.match(appJs, /url\.hostname !== "pair"/);
  assert.match(appJs, /activateNativeLan/);
  assert.match(appJs, /performNativeFeedback/);
  assert.match(appJs, /closest\('button, \[role="button"\], input\[type="checkbox"\], select'\)/);
  assert.match(appJs, /control\.id === "recordButton"/);
  // LAN 自动恢复 + 预取 + 按键回执 + 耗时观测（回归修复包）。
  assert.match(appJs, /maybeRestoreNativeLan/);
  assert.match(appJs, /rememberNativeLanEndpoint/);
  assert.match(appJs, /asr-prefetch/);
  assert.match(appJs, /payload\.type === "ack" && payload\.key/);
  assert.match(appJs, /createRecordingTimingStore/);
  await access(new URL("www/nativeFeedback.js", mobileRoot));
  await access(new URL("www/timingRecorder.js", mobileRoot));
  await access(new URL("www/vendor/supabase.js", mobileRoot));
});

test("native projects declare microphone and local-network access", async () => {
  const [iosInfo, iosDelegate, iosSceneDelegate, androidManifest] = await Promise.all([
    readFile(new URL("ios/App/App/Info.plist", mobileRoot), "utf8"),
    readFile(new URL("ios/App/App/AppDelegate.swift", mobileRoot), "utf8"),
    readFile(new URL("ios/App/App/SceneDelegate.swift", mobileRoot), "utf8"),
    readFile(new URL("android/app/src/main/AndroidManifest.xml", mobileRoot), "utf8")
  ]);
  assert.match(iosInfo, /NSMicrophoneUsageDescription/);
  assert.match(iosInfo, /NSLocalNetworkUsageDescription/);
  assert.match(iosInfo, /NSCameraUsageDescription/);
  assert.match(iosInfo, /NSAllowsArbitraryLoadsInWebContent/);
  assert.match(iosDelegate, /VoiceBridgeFeedbackPlugin/);
  assert.match(iosDelegate, /AudioServicesPlaySystemSoundWithCompletion/);
  assert.match(iosSceneDelegate, /VoiceBridgeViewController/);
  assert.match(androidManifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(androidManifest, /android\.permission\.INTERNET/);
  assert.match(androidManifest, /android:usesCleartextTraffic="true"/);
});

test("mobile dependency tree has no runtime CDN or vulnerable override drift", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", mobileRoot), "utf8"));
  assert.match(packageJson.dependencies["@capacitor/core"], /^\^8\./);
  assert.match(packageJson.dependencies["@capacitor/barcode-scanner"], /^\^3\./);
  assert.match(packageJson.dependencies["@capacitor/haptics"], /^\^8\./);
  assert.equal(packageJson.overrides.uuid, "11.1.1");
});
