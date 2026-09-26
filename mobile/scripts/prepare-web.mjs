import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(mobileDir, "..");
const sourceDir = path.join(projectRoot, "hosted-pwa", "dist", "client");
const webDir = path.join(mobileDir, "www");

await rm(webDir, { recursive: true, force: true });
await mkdir(webDir, { recursive: true });
await cp(sourceDir, webDir, { recursive: true });
await rm(path.join(webDir, "index.html"), { force: true });
await rename(path.join(webDir, "app.html"), path.join(webDir, "index.html"));

const configPath = path.join(webDir, "config.js");
const config = await readFile(configPath, "utf8");
await writeFile(
  configPath,
  config.replace("voicebridgeMode: \"cloud\",", "voicebridgeMode: \"cloud\",\n  nativeApp: true,"),
  "utf8"
);

console.log("Prepared bundled VoiceBridge mobile web assets");
