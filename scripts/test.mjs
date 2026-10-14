import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major >= 24 || (major === 22 && minor >= 18))) {
  throw new Error("VoiceBridge verification requires Node.js 22.18+ (22.x) or 24+. TypeScript tests use native type stripping.");
}
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target);
    else if (/\.test\.(?:js|mjs)$/.test(entry.name)) files.push(target);
  }
}
// Test authored sources once; generated PWA/mobile copies have separate checks.
for (const directory of ["src", "supabase/functions", "scripts"]) {
  await collect(path.join(root, directory));
}
if (!files.length) throw new Error("No source tests found");
const child = spawn(process.execPath, [
  "--test", "--test-concurrency=1", ...process.argv.slice(2), ...files.sort()
], { cwd: root, stdio: "inherit" });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
