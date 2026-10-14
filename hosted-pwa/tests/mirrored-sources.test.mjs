import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyMirroredSources } from "../scripts/mirrored-sources.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voicebridge-mirror-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cloud = path.join(root, "cloud");
  for (const directory of ["src/shared", "src/public/i18n", "cloud/shared", "cloud/i18n"]) await mkdir(path.join(root, directory), { recursive: true });
  for (const name of ["protocol.js", "planLimits.js"]) {
    for (const directory of ["src/shared", "cloud/shared"]) await writeFile(path.join(root, directory, name), "export const value = 1;\n");
  }
  for (const [name, content] of [["index.html", "<h1>App</h1>"], ["style.css", "body { color: red; }"], ["i18n/en.js", "export const text='hello';"]]) {
    await writeFile(path.join(root, "src/public", name), content);
    await writeFile(path.join(cloud, name === "index.html" ? "app.html" : name), content);
  }
  return { root, cloud };
}
test("mirror gate checks nested translations and styles", async (t) => {
  const { root, cloud } = await fixture(t);
  await verifyMirroredSources(root, cloud);
  await writeFile(path.join(cloud, "i18n/en.js"), "export const text='stale';");
  await assert.rejects(verifyMirroredSources(root, cloud), /Cloud source drift.*i18n/);
});
test("mirror gate rejects an unshipped new production module", async (t) => {
  const { root, cloud } = await fixture(t);
  await writeFile(path.join(root, "src/public/new.js"), "export const module = true;");
  await assert.rejects(verifyMirroredSources(root, cloud), { code: "ENOENT" });
});
test("mirror gate maps app entry and shared import paths without requiring test copies", async (t) => {
  const { root, cloud } = await fixture(t);
  await writeFile(path.join(root, "src/public/app.js"), 'import { value } from "../shared/protocol.js";\n');
  await writeFile(path.join(cloud, "app.js"), 'import { value } from "./shared/protocol.js";\n');
  await writeFile(path.join(root, "src/public/manifest.json"), '{"start_url": "/", "name": "VoiceBridge"}\n');
  await writeFile(path.join(cloud, "manifest.json"), '{"start_url": "/app", "name": "VoiceBridge"}\n');
  await writeFile(path.join(root, "src/public/app.test.js"), "not a shipped module");
  await verifyMirroredSources(root, cloud);
});
