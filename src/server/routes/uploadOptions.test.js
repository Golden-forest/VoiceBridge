import test from "node:test";
import assert from "node:assert/strict";

import { resolveAutoPaste } from "./uploadOptions.js";

test("resolveAutoPaste honors the phone switch over server default", () => {
  assert.equal(resolveAutoPaste("false", true), false);
  assert.equal(resolveAutoPaste("true", false), true);
  assert.equal(resolveAutoPaste(undefined, false), false);
});
