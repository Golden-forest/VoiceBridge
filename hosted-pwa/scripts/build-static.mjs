import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const publicDir = path.join(root, "public");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "server"), { recursive: true });
await mkdir(path.join(dist, "client"), { recursive: true });
await mkdir(path.join(dist, ".openai"), { recursive: true });

await cp(publicDir, path.join(dist, "client"), { recursive: true });
await cp(path.join(root, "worker", "static.js"), path.join(dist, "server", "index.js"));
await cp(
  path.join(root, ".openai", "hosting.json"),
  path.join(dist, ".openai", "hosting.json")
);

for (const required of [
  "client/index.html",
  "client/config.js",
  "client/manifest.json",
  "client/shared/protocol.js",
  "server/index.js",
  ".openai/hosting.json"
]) {
  await access(path.join(dist, required));
}

const config = await readFile(path.join(dist, "client", "config.js"), "utf8");
if (!config.includes('voicebridgeMode: "cloud"')) {
  throw new Error("Hosted config is not set to cloud mode");
}

console.log("Built VoiceBridge Hosted PWA");
