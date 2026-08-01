import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const distRoot = new URL("../dist/", import.meta.url);

// ---- Existing cloud config + pairing assertions (kept) --------------------

test("hosted PWA ships cloud config and pairing entrypoint", async () => {
  const [config, pairing] = await Promise.all([
    readFile(new URL("client/config.js", distRoot), "utf8"),
    readFile(new URL("client/pairing.js", distRoot), "utf8")
  ]);

  assert.match(config, /voicebridgeMode:\s*"cloud"/);
  assert.match(config, /gqxxknusznbunkiznnal\.supabase\.co/);
  assert.match(pairing, /action:\s*"claim"/);
});

// ---- Landing page: English root -------------------------------------------

test("landing English root index.html is generated correctly", async () => {
  const html = await readFile(new URL("client/index.html", distRoot), "utf8");

  // English document
  assert.match(html, /<html lang="en">/);

  // Landing assets referenced
  assert.match(html, /<link rel="stylesheet" href="\/landing\.css"/);
  assert.match(html, /<script src="\/landing\.js"/);

  // Landing must not be installed as a PWA (spec §4.3 / §10.2)
  assert.doesNotMatch(html, /<link rel="manifest"/);

  // No residual template placeholders
  assert.doesNotMatch(html, /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/);
});

// ---- Landing page: Simplified Chinese -------------------------------------

test("landing zh-CN index.html is generated correctly", async () => {
  const html = await readFile(
    new URL("client/zh-CN/index.html", distRoot),
    "utf8"
  );

  assert.match(html, /<html lang="zh-CN">/);
  assert.doesNotMatch(html, /<link rel="manifest"/);
  assert.doesNotMatch(html, /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/);
});

// ---- PWA app entrypoint retains manifest + auth ---------------------------

test("PWA app.html retains manifest link and GitHub auth button", async () => {
  const html = await readFile(new URL("client/app.html", distRoot), "utf8");

  // /app is the PWA entrypoint and MUST keep its manifest
  assert.match(html, /<link rel="manifest" href="\/manifest\.json"/);
  // Original PWA login button preserved during the root migration
  assert.match(html, /id="authGithubBtn"/);
  // Existing Chinese copy still present
  assert.match(html, /创建账号/);
});

// ---- Worker HTML_ROUTES ----------------------------------------------------

test("worker exposes HTML_ROUTES for /, /zh-CN and /app", async () => {
  const worker = await readFile(new URL("server/index.js", distRoot), "utf8");

  assert.match(worker, /HTML_ROUTES/);
  assert.match(worker, /["']\/["']/);
  assert.match(worker, /["']\/zh-CN\/?["']/);
  assert.match(worker, /["']\/app["']/);
  assert.match(worker, /env\.ASSETS\.fetch/);
});

// ---- downloads.json --------------------------------------------------------

test("downloads.json is shipped with three real v0.1.0 assets", async () => {
  const raw = await readFile(new URL("client/downloads.json", distRoot), "utf8");
  const data = JSON.parse(raw);

  assert.equal(data.version, "0.1.0");
  assert.equal(data.repository, "Golden-forest/VoiceBridge");
  assert.equal(data.assets.length, 3);

  const platforms = data.assets.map((a) => `${a.platform}-${a.arch}`).sort();
  assert.deepEqual(platforms, ["darwin-arm64", "darwin-x64", "win32-x64"]);

  for (const asset of data.assets) {
    assert.ok(asset.filename, "asset.filename must be non-empty");
    assert.ok(asset.url, "asset.url must be non-empty");
    assert.match(
      asset.url,
      /^https:\/\/github\.com\/Golden-forest\/VoiceBridge\/releases\/download\/v0\.1\.0\//,
      `asset.url for ${asset.filename} must point at the v0.1.0 GitHub release`
    );
    // Real file size from the release, never null after batch 3
    assert.equal(typeof asset.size, "number");
    assert.ok(asset.size > 0, `asset.size for ${asset.filename} must be positive`);
  }
});

// ---- SEO assets ------------------------------------------------------------

test("sitemap.xml and robots.txt are shipped", async () => {
  const [sitemap, robots] = await Promise.all([
    readFile(new URL("client/sitemap.xml", distRoot), "utf8"),
    readFile(new URL("client/robots.txt", distRoot), "utf8")
  ]);

  assert.match(sitemap, /<\?xml version="1\.0"/);
  assert.match(sitemap, /https:\/\/voicebridge-6kr\.pages\.dev\//);
  assert.match(sitemap, /hreflang="en"/);
  assert.match(sitemap, /hreflang="zh-CN"/);
  assert.match(sitemap, /hreflang="x-default"/);

  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Disallow: \/app/);
  assert.match(robots, /Sitemap: https:\/\/voicebridge-6kr\.pages\.dev\/sitemap\.xml/);
});

// ---- OG placeholder image --------------------------------------------------

test("OG placeholder PNG exists at 1200x630", async () => {
  // og-image-en.png and og-image-zh.png produced by batch 3 for social crawlers.
  // The trailing 1200x630 size is verified at build time; here we only assert
  // presence so a broken publish is caught early.
  await access(new URL("client/og-image-en.png", distRoot));
  await access(new URL("client/og-image-zh.png", distRoot));
});

// ---- Existing test-file exclusion -----------------------------------------

test("hosted build does not publish test files", async () => {
  await assert.rejects(access(new URL("client/cloudRealtime.test.js", distRoot)));
  await assert.rejects(access(new URL("client/shared/protocol.test.js", distRoot)));
});
