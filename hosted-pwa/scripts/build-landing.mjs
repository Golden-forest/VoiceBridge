// build-landing.mjs
// Reads landing/template.html + two locale JSON files, validates key-tree parity,
// substitutes {{ a.b.c }} placeholders, and writes public/index.html (en)
// and public/zh-CN/index.html (zh-CN). No third-party deps.
//
// Spec: docs/superpowers/specs/2026-08-01-landing-page-design.md §3.4

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const landingDir = path.join(root, "landing");
const publicDir = path.join(root, "public");

const templatePath = path.join(landingDir, "template.html");
const enLocalePath = path.join(landingDir, "locales", "en.json");
const zhLocalePath = path.join(landingDir, "locales", "zh-CN.json");

const enOutPath = path.join(publicDir, "index.html");
const zhOutPath = path.join(publicDir, "zh-CN", "index.html");

// ---- helpers --------------------------------------------------------------

/**
 * Collect every leaf path (dot-joined) of a nested JSON object.
 * Arrays are treated as leaf values (so they can hold typewriter strings etc.).
 */
function collectLeaves(obj, prefix = "", out = []) {
  if (obj === null || typeof obj !== "object") {
    // Primitive leaf
    out.push(prefix);
    return out;
  }
  if (Array.isArray(obj)) {
    // Arrays count as a single leaf at their key path.
    out.push(prefix);
    return out;
  }
  for (const key of Object.keys(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    collectLeaves(obj[key], next, out);
  }
  return out;
}

/**
 * Recursively assert that two locale JSONs share an identical key tree,
 * including array-vs-object shape (so an array cannot silently become an object).
 */
function assertKeyTreeEqual(a, b, pathStr = "") {
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) {
    throw new Error(
      `Locale key-tree mismatch at "${pathStr}": one side is array, the other is not.`
    );
  }
  if (aIsArr) {
    if (a.length !== b.length) {
      throw new Error(
        `Locale key-tree mismatch at "${pathStr}": array length differs (${a.length} vs ${b.length}).`
      );
    }
    return;
  }
  const aIsObj = a !== null && typeof a === "object";
  const bIsObj = b !== null && typeof b === "object";
  if (aIsObj !== bIsObj) {
    throw new Error(
      `Locale key-tree mismatch at "${pathStr}": object/primitive shape differs.`
    );
  }
  if (!aIsObj) {
    // Both primitives: fine.
    return;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    throw new Error(
      `Locale key-tree mismatch at "${pathStr}": key count differs (${aKeys.length} vs ${bKeys.length}).`
    );
  }
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) {
      throw new Error(
        `Locale key-tree mismatch at "${pathStr}": key "${k}" missing on zh-CN side.`
      );
    }
    const next = pathStr ? `${pathStr}.${k}` : k;
    assertKeyTreeEqual(a[k], b[k], next);
  }
}

/**
 * Reject empty values (empty string, null, undefined).
 * Arrays must be non-empty and every entry must be a non-empty string.
 */
function assertNoEmpty(locale, pathStr = "") {
  if (locale === null || locale === undefined) {
    throw new Error(`Locale value is null/undefined at "${pathStr}".`);
  }
  if (typeof locale === "string") {
    if (locale.trim() === "") {
      throw new Error(`Locale value is empty string at "${pathStr}".`);
    }
    return;
  }
  if (Array.isArray(locale)) {
    if (locale.length === 0) {
      throw new Error(`Locale array is empty at "${pathStr}".`);
    }
    locale.forEach((entry, idx) => {
      const np = `${pathStr}[${idx}]`;
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new Error(`Locale array entry is empty at "${np}".`);
      }
    });
    return;
  }
  if (typeof locale === "object") {
    for (const k of Object.keys(locale)) {
      const np = pathStr ? `${pathStr}.${k}` : k;
      assertNoEmpty(locale[k], np);
    }
    return;
  }
  // numbers/booleans not used in locale schema but accepted
}

/**
 * Resolve a dot-path like "hero.cta_primary" against the locale object.
 * Throws if any segment is missing.
 */
function resolvePath(locale, dotPath) {
  const segments = dotPath.split(".");
  let cur = locale;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      throw new Error(`Cannot descend into "${seg}" at path "${dotPath}".`);
    }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
      throw new Error(`Locale missing key "${dotPath}" (failed at "${seg}").`);
    }
    cur = cur[seg];
  }
  return cur;
}

/**
 * Substitute every {{ a.b.c }} placeholder in template.
 * - strings -> inlined as text (HTML-escaped)
 * - arrays  -> JSON.stringify-ed (for embedding in <script type="application/json">)
 * Numbers/booleans are inlined as-is.
 *
 * Returns { html, replacedCount, uniqueKeys }.
 */
function substitute(templateHtml, locale, localeName) {
  let replacedCount = 0;
  const uniqueKeys = new Set();

  // Match {{ path.to.key }} allowing surrounding whitespace.
  const placeholderRe = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*\}\}/g;

  const result = templateHtml.replace(placeholderRe, (full, keyPath) => {
    const value = resolvePath(locale, keyPath);
    uniqueKeys.add(keyPath);
    replacedCount += 1;

    if (Array.isArray(value)) {
      // JSON island inlining; landing.js reads textContent, so no escaping needed
      // beyond valid JSON. JSON.stringify already produces JS-safe output inside
      // <script type="application/json"> as long as "</script>" sequence does not
      // appear. Our strings are plain copy; guard anyway.
      const json = JSON.stringify(value);
      return json.replace(/<\/script/gi, "<\\/script");
    }
    if (typeof value === "string") {
      return escapeHtml(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    throw new Error(
      `Unsupported value type at "${keyPath}" in ${localeName}: ${typeof value}`
    );
  });

  return { html: result, replacedCount, uniqueKeys };
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * After substitution, no {{ or }} sequence should remain inside the document.
 * We ignore JSON-ish occurrences inside <script type="application/json"> only if
 * they were produced by us (which are already JSON.stringify-ed and would not
 * contain literal {{ }} unless a translated string contained them — which is
 * forbidden for copy).
 */
function assertNoResidualPlaceholders(html) {
  // Look for the placeholder shape specifically to avoid false positives
  // from legitimate CSS / JSON braces.
  const residual = /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/.exec(html);
  if (residual) {
    throw new Error(`Unresolved template placeholder: "${residual[0]}"`);
  }
}

// ---- main -----------------------------------------------------------------

async function main() {
  const [templateHtml, enRaw, zhRaw] = await Promise.all([
    readFile(templatePath, "utf8"),
    readFile(enLocalePath, "utf8"),
    readFile(zhLocalePath, "utf8"),
  ]);

  const en = JSON.parse(enRaw);
  const zh = JSON.parse(zhRaw);

  // 1. Validate identical key tree
  assertKeyTreeEqual(en, zh);

  // 2. Validate no empty values on either side
  assertNoEmpty(en);
  assertNoEmpty(zh);

  // 3. Output directory for zh-CN
  await mkdir(path.dirname(zhOutPath), { recursive: true });

  // 4. Substitute + validate + write
  const enSub = substitute(templateHtml, en, "en");
  assertNoResidualPlaceholders(enSub.html);

  const zhSub = substitute(templateHtml, zh, "zh-CN");
  assertNoResidualPlaceholders(zhSub.html);

  await writeFile(enOutPath, enSub.html, "utf8");
  await writeFile(zhOutPath, zhSub.html, "utf8");

  // 5. Sanity: both locales should have substituted exactly the same set of keys.
  // If not, the template references a key that exists only in one locale.
  if (enSub.uniqueKeys.size !== zhSub.uniqueKeys.size) {
    throw new Error(
      `Substituted key count differs between en (${enSub.uniqueKeys.size}) and zh-CN (${zhSub.uniqueKeys.size}).`
    );
  }
  for (const k of enSub.uniqueKeys) {
    if (!zhSub.uniqueKeys.has(k)) {
      throw new Error(
        `Key "${k}" was substituted in en but not in zh-CN; locale trees may have drifted.`
      );
    }
  }

  // Also confirm every collected leaf key appears in the template.
  // This catches unused locale keys (spec does not strictly forbid, but warns).
  const allLeaves = new Set(collectLeaves(en));
  const unused = [...allLeaves].filter((k) => !enSub.uniqueKeys.has(k));
  if (unused.length > 0) {
    console.warn(
      `[build-landing] Warning: ${unused.length} locale key(s) unused in template:`,
      unused.join(", ")
    );
  }

  console.log(
    `[build-landing] en   -> ${path.relative(root, enOutPath)}  (${enSub.replacedCount} placeholders)`
  );
  console.log(
    `[build-landing] zh-CN -> ${path.relative(root, zhOutPath)}  (${zhSub.replacedCount} placeholders)`
  );
  console.log(
    `[build-landing] unique keys substituted: ${enSub.uniqueKeys.size}`
  );
}

main().catch((err) => {
  console.error("[build-landing] FAILED:", err);
  process.exit(1);
});
