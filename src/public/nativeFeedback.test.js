import assert from "node:assert/strict";
import test from "node:test";

import { performNativeFeedback } from "./nativeFeedback.js";

test("native feedback is disabled in the browser PWA", () => {
  assert.equal(performNativeFeedback("success", { __VB_CONFIG: { nativeApp: false } }), false);
});

test("native feedback routes success through the Capacitor Haptics plugin", () => {
  let notificationType = "";
  const win = {
    __VB_CONFIG: { nativeApp: true },
    Capacitor: {
      Plugins: {
        Haptics: {
          notification: async ({ type }) => { notificationType = type; }
        }
      }
    }
  };
  assert.equal(performNativeFeedback("success", win), true);
  assert.equal(notificationType, "SUCCESS");
});
