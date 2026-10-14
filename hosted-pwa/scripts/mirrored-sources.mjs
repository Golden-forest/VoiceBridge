import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function verifyMirroredSources(projectRoot, publicDir) {
  for (const relative of ["shared/protocol.js", "shared/planLimits.js"]) {
    await compare(path.join(projectRoot, "src", relative), path.join(publicDir, relative), relative);
  }
  const source = path.join(projectRoot, "src/public");
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) { await walk(path.join(directory, entry.name), relative); continue; }
      if (/\.test\.(?:js|mjs)$/.test(entry.name)) continue;
      if (!/\.(?:js|css|html)$/.test(entry.name) && !["manifest.json", "commands.example.json"].includes(relative)) continue;
      const target = relative === "index.html" ? "app.html" : relative;
      await compare(path.join(source, relative), path.join(publicDir, target), relative, true);
    }
  }
  await walk(source);
}

async function compare(localPath, cloudPath, relative, normalize = false) {
  const [local, cloud] = await Promise.all([readFile(localPath, "utf8"), readFile(cloudPath, "utf8")]);
  let expected = normalize ? local
    .replaceAll(/"\.\.\/shared\/([^"]+\.js)"/g, '"./shared/$1"')
    .replaceAll('"./index.html"', '"./app.html"') : local;
  // The local server serves the app at /; hosted / is the landing page.
  if (normalize && relative === "manifest.json") {
    expected = expected.replace('"start_url": "/"', '"start_url": "/app"');
  }
  if (expected !== cloud) throw new Error(`Cloud source drift detected: ${relative}`);
}
