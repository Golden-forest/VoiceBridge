import test from "node:test";
import assert from "node:assert/strict";

import { transcribeAudio } from "./transcriber.js";

test("transcribeAudio returns a user-facing error when API key is missing", async () => {
  await assert.rejects(
    () =>
      transcribeAudio(
        { filePath: "/tmp/missing.webm", tmpDir: "/tmp" },
        { asrProvider: "tencent", tencentSecretId: "", tencentSecretKey: "" }
      ),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.match(error.publicMessage, /腾讯云/);
      return true;
    }
  );
});
