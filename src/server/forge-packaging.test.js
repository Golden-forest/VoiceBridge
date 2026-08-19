import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Electron 打包回归测试：main.js 动态 import `src/server/createLanServer.js`，
// `src/public` 也是 LAN 模式的静态资源根。forge packagerConfig.ignore 的任意
// 正则都不能匹配这两个目录下的路径，否则打包后的应用 LAN 功能静默缺失
// （动态 import 失败 → lan-module-unavailable）。
test("forge packagerConfig ignore patterns do not exclude src/server or src/public", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const ignore = pkg.config.forge.packagerConfig.ignore;
  assert.ok(Array.isArray(ignore), "forge ignore must be an array");

  const mustShip = [
    "/src/server/createLanServer.js",
    "/src/server/index.js",
    "/src/server/certs.js",
    "/src/server/ws.js",
    "/src/public/app.js",
    "/src/public/index.html"
  ];

  for (const pattern of ignore) {
    const regex = new RegExp(pattern);
    for (const filePath of mustShip) {
      assert.equal(
        regex.test(filePath),
        false,
        `forge ignore pattern ${pattern} would exclude ${filePath} from the packaged app`
      );
    }
  }
});
