// Venstock's public site (site/): a separate static-assets-only Worker at the apex, held to the rules in CLAUDE.md
// and docs/before-first-vendor.md section 11: a strict Content-Security-Policy, no scripts, no forms, no cookies,
// nothing loaded from another origin, and only Venstock's own pages. The design rules for site/ CSS are in
// tests/design.unit.test.mjs and tests/contrast.unit.test.mjs. Part of test:fast (reads files only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const PUB = join(SITE, "public");
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const files = walk(PUB);
const pages = files.filter((p) => extname(p) === ".html");
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => relative(ROOT, p);

test("site/wrangler.toml: static assets only, no code, no bindings, the apex route, no workers.dev or previews", () => {
  const toml = read(join(SITE, "wrangler.toml")).replace(/^\s*#.*$/gm, "");
  assert.match(toml, /^name = "venstock-site"$/m);
  assert.notEqual(/^name = "([^"]+)"/m.exec(read(join(ROOT, "wrangler.toml")))[1], "venstock-site", "not the vendor Worker's name");
  assert.doesNotMatch(toml, /^\s*main\s*=/m, "no Worker code: static files only");
  for (const binding of ["d1_databases", "kv_namespaces", "r2_buckets", "services", "durable_objects", "queues", "vars", "ai", "browser", "vectorize", "hyperdrive", "analytics_engine_datasets"]) {
    assert.doesNotMatch(toml, new RegExp(`^\\s*\\[\\[?${binding}`, "m"), `no ${binding}`);
  }
  assert.doesNotMatch(toml, /^\s*binding\s*=/m, "the assets have no binding (nothing could read them as code)");
  assert.match(toml, /^\[assets\]\ndirectory = "public"$/m);
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^preview_urls = false$/m);
  const routes = [...toml.matchAll(/^pattern = "([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(routes, ["venstock.org/*"], "the apex only: every subdomain belongs to the vendor Worker");
  assert.match(toml, /^zone_name = "venstock\.org"$/m);
});

test("_headers: a strict Content-Security-Policy and the other headers on every path, and no cookies", () => {
  const h = read(join(PUB, "_headers"));
  const block = /^\/\*\n((?:[ \t]+.+\n?)+)/m.exec(h);
  assert.ok(block, "_headers has a block for /*");
  const headers = Object.fromEntries(block[1].trim().split("\n").map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]; }));
  const csp = Object.fromEntries(headers["content-security-policy"].split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(" ")]));
  assert.deepEqual(csp, {
    "default-src": "'none'", "style-src": "'self'", "font-src": "'self'", "img-src": "'self'",
    "base-uri": "'none'", "form-action": "'none'", "frame-ancestors": "'none'",
  });
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.doesNotMatch(h, /set-cookie/i);
});

test("pages: no scripts, no forms, no frames, no inline styles or event handlers, no cookies", () => {
  assert.ok(pages.length >= 4, `pages: ${pages.map(rel)}`);
  for (const p of pages) {
    const html = read(p);
    for (const [re, what] of [[/<script/i, "script"], [/<form/i, "form"], [/<(iframe|object|embed|frame)\b/i, "embedded content"],
      [/\sstyle\s*=/i, "inline style"], [/<style/i, "style tag"], [/\son[a-z]+\s*=/i, "event handler"], [/document\.cookie|set-cookie/i, "cookie"],
      [/<meta[^>]+http-equiv/i, "http-equiv meta"]]) {
      assert.doesNotMatch(html, re, `${rel(p)} has a ${what}`);
    }
    assert.match(html, /<meta name="referrer" content="no-referrer">/, rel(p));
  }
  assert.deepEqual(files.filter((p) => /\.(js|mjs|wasm)$/.test(p)).map(rel), [], "no script files at all");
});

test("nothing loads from another origin; external links only to the Stripe payment page or by email", () => {
  for (const p of files.filter((f) => /\.(html|css)$/.test(f) || f.endsWith("_headers"))) {
    const text = read(p);
    // resources: src, link href, CSS url() and @import must be same-origin paths
    for (const m of text.matchAll(/(?:\ssrc|<link[^>]*\shref)\s*=\s*"([^"]+)"|url\(\s*["']?([^"')]+)|@import\s+["']?([^"'; ]+)/gi)) {
      const url = m[1] || m[2] || m[3];
      assert.match(url, /^\/[^/]/, `${rel(p)} loads ${url}: only same-origin paths are allowed`);
    }
    // links people can follow: same-site, mailto, or the Stripe payment link
    for (const m of text.matchAll(/<a\b[^>]*\shref\s*=\s*"([^"]+)"/gi)) {
      const url = m[1];
      const ok = /^(\/|#)/.test(url) || /^mailto:[^@\s]+@venstock\.org$/.test(url) || /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_-]+$/.test(url);
      assert.ok(ok, `${rel(p)} links to ${url}`);
    }
    // and no stray absolute URLs anywhere else in the markup (comments excepted)
    const bare = text.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*#.*$/gm, "").match(/https?:\/\/[^\s"'<)]+/g) || [];
    assert.deepEqual(bare.filter((u) => !/^https:\/\/buy\.stripe\.com\//.test(u)), [], `${rel(p)} mentions another site`);
  }
});

// Cloudflare's static assets serve /what from what.html (and redirect /what.html to /what), so pages link to /what.
const fileFor = (url) => {
  const path = url.replace(/[#?].*$/, "");
  if (path === "/") return join(PUB, "index.html");
  if (extname(path)) return join(PUB, path);
  return join(PUB, `${path}.html`);
};
const PAGES = [["/what", "What it is"], ["/how", "How it works"], ["/pricing", "Pricing"], ["/join", "Join"]];

test("every same-site link and resource points at a file that exists", () => {
  for (const p of pages) {
    for (const m of read(p).matchAll(/\s(?:href|src)\s*=\s*"(\/[^"#?]*)/g)) {
      assert.ok(existsSync(fileFor(m[1])), `${rel(p)} -> ${m[1]} does not exist in site/public`);
    }
    for (const id of [...read(p).matchAll(/href="#([^"]+)"/g)].map((m) => m[1])) {
      assert.match(read(p), new RegExp(`id="${id}"`), `${rel(p)} links to #${id}, which isn't on the page`);
    }
  }
});

test("one page per header link: every page has the same header, marks its own page, and names the provider", () => {
  for (const [href] of PAGES) assert.ok(existsSync(fileFor(href)), `${href} has a page`);
  for (const p of pages) {
    const html = read(p);
    const nav = /<nav class="label" aria-label="Pages">([\s\S]*?)<\/nav>/.exec(html);
    assert.ok(nav, `${rel(p)} has the header navigation`);
    assert.deepEqual([...nav[1].matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), PAGES, `${rel(p)} header links`);
    const own = PAGES.find(([href]) => fileFor(href) === p);
    const current = [...nav[1].matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((m) => m[1]);
    assert.deepEqual(current, own ? [own[0]] : [], `${rel(p)} marks only its own page as current`);
    assert.match(html, /provided by Medein LLC/, `${rel(p)} footer names the provider`);
    assert.match(html, /<a href="\/terms">Terms<\/a><a href="\/privacy">Privacy<\/a>/, `${rel(p)} links terms and privacy`);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${rel(p)} has exactly one h1`);
  }
  assert.match(read(fileFor("/pricing")), /\$50/, "pricing shows the setup fee");
  assert.match(read(fileFor("/join")), /mailto:/, "join has the contact email");
  assert.match(read(fileFor("/join")), /class="button"/, "join has the payment button");
});

test("no invented proof: no testimonials, statistics, ratings, customer names or logos", () => {
  for (const p of pages) {
    const text = read(p).replace(/<!--[\s\S]*?-->/g, "");
    assert.doesNotMatch(text, /testimonial|trusted by|customers? (say|love)|loved by|as seen|\brated\b|\breviews?\b|★|☆|\d+\s*%|\d[\d,]*\+\s*(vendors|shops|customers|sales|users)/i, rel(p));
    assert.doesNotMatch(text, /<img|<svg|<picture/i, `${rel(p)}: no images or logos`);
  }
});

test("tokens.css and the fonts are exact copies of the vendor app's", () => {
  assert.equal(read(join(PUB, "tokens.css")), read(join(ROOT, "public", "tokens.css")), "site/public/tokens.css differs from public/tokens.css");
  for (const f of readdirSync(join(ROOT, "public", "fonts"))) {
    assert.deepEqual(readFileSync(join(PUB, "fonts", f)), readFileSync(join(ROOT, "public", "fonts", f)), `fonts/${f} differs`);
  }
  assert.deepEqual(readdirSync(join(PUB, "fonts")).sort(), readdirSync(join(ROOT, "public", "fonts")).sort());
});
