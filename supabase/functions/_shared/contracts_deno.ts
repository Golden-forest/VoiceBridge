import { assertEquals } from "jsr:@std/assert";

import { ERROR_CODE_QUOTA_EXCEEDED, USAGE_PROVIDER_TENCENT_CLOUD } from "./contracts.ts";

Deno.test("transcribe usage contract constants match persisted API values", () => {
  assertEquals(USAGE_PROVIDER_TENCENT_CLOUD, "tencent_cloud");
  assertEquals(ERROR_CODE_QUOTA_EXCEEDED, "quota_exceeded");
});
