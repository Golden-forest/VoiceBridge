import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function parseEdgeFunctions(config) {
  const sections = [...config.matchAll(/^\[functions\.([a-z0-9-]+)\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)];
  if (!sections.length) throw new Error("No Edge Functions declared in config.toml");
  const seen = new Set();
  return sections.map(([, name, body]) => {
    const setting = body.match(/^verify_jwt\s*=\s*(true|false)\s*(?:#.*)?$/m);
    if (!setting || seen.has(name)) throw new Error(`Invalid function configuration: ${name}`);
    seen.add(name);
    return { name, verifyJwt: setting[1] === "true" };
  });
}

export async function loadEdgeFunctions(root = fileURLToPath(new URL("../", import.meta.url))) {
  const config = await readFile(path.join(root, "supabase/config.toml"), "utf8");
  const functions = parseEdgeFunctions(config);
  const directories = await readdir(path.join(root, "supabase/functions"), { withFileTypes: true });
  const implemented = [];
  for (const entry of directories.filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))) {
    await readFile(path.join(root, "supabase/functions", entry.name, "index.ts"), "utf8");
    implemented.push(entry.name);
  }
  if (functions.map(({ name }) => name).sort().join(",") !== implemented.sort().join(",")) {
    throw new Error("Edge Function manifest must match all implemented function directories");
  }
  return functions;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { name, verifyJwt } of await loadEdgeFunctions()) console.log(`${name}:${verifyJwt}`);
}
