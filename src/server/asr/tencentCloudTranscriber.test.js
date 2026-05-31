import test from "node:test";
import assert from "node:assert/strict";

import { createTencentSentenceRecognitionRequest } from "./tencentCloudTranscriber.js";

test("createTencentSentenceRecognitionRequest builds a signed SentenceRecognition request", () => {
  const request = createTencentSentenceRecognitionRequest({
    audioBase64: Buffer.from("audio").toString("base64"),
    audioLength: 5,
    timestamp: 1710000000,
    config: {
      tencentSecretId: "secret-id",
      tencentSecretKey: "secret-key",
      tencentAsrRegion: "ap-shanghai",
      tencentAsrEngServiceType: "16k_zh",
      tencentAsrVoiceFormat: "wav"
    }
  });

  assert.equal(request.headers["X-TC-Action"], "SentenceRecognition");
  assert.equal(request.headers["X-TC-Version"], "2019-06-14");
  assert.equal(request.headers["X-TC-Region"], "ap-shanghai");
  assert.equal(request.payload.SourceType, 1);
  assert.equal(request.payload.VoiceFormat, "wav");
  assert.equal(request.payload.Data, Buffer.from("audio").toString("base64"));
  assert.equal(request.payload.DataLen, 5);
  assert.match(request.headers.Authorization, /TC3-HMAC-SHA256 Credential=secret-id/);
  assert.doesNotMatch(request.headers.Authorization, /secret-key/);
});
