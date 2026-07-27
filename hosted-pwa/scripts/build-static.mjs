import { access, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const publicDir = path.join(root, "public");
const projectRoot = path.resolve(root, "..");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "server"), { recursive: true });
await mkdir(path.join(dist, "client"), { recursive: true });
await mkdir(path.join(dist, ".openai"), { recursive: true });

await verifyMirroredSources();
await cp(publicDir, path.join(dist, "client"), { recursive: true });
await removeTestFiles(path.join(dist, "client"));
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

async function removeTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeTestFiles(entryPath);
    } else if (entry.name.endsWith(".test.js")) {
      await rm(entryPath);
    }
  }));
}

async function verifyMirroredSources() {
  const exactMirrors = ["shared/protocol.js", "shared/planLimits.js"];
  for (const relativePath of exactMirrors) {
    const [localSource, cloudSource] = await Promise.all([
      readFile(path.join(projectRoot, "src", relativePath), "utf8"),
      readFile(path.join(publicDir, relativePath), "utf8")
    ]);
    if (localSource !== cloudSource) {
      throw new Error(`Cloud source drift detected: ${relativePath}`);
    }
  }

  for (const relativePath of ["app.js", "cloudRealtime.js"]) {
    const [localSource, cloudSource] = await Promise.all([
      readFile(path.join(projectRoot, "src", "public", relativePath), "utf8"),
      readFile(path.join(publicDir, relativePath), "utf8")
    ]);
    const normalizedLocalSource = localSource.replaceAll(
      '"../shared/protocol.js"',
      '"./shared/protocol.js"'
    );
    if (normalizedLocalSource !== cloudSource) {
      throw new Error(`Cloud source drift detected: ${relativePath}`);
    }
  }
}
