// The design rules (docs/design.md) as source checks over public/ and site/: no rounded corners, no blurred
// shadows, no gradients or backdrop blur, no banned fonts, colours only in tokens.css, no emoji used as icons, the
// font budget and licences, and every shell file in the service worker's cache list. Part of test:fast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (dir) => !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const FILES = [...walk(join(ROOT, "public")), ...walk(join(ROOT, "site"))].filter((p) => !p.includes(`${join("public", "vendor")}`));
const ofType = (...exts) => FILES.filter((p) => exts.includes(extname(p)));
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => relative(ROOT, p);
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// CSS from stylesheets plus inline style="" attributes and style strings in HTML and JS.
function cssSources() {
  const out = ofType(".css").map((p) => [rel(p), stripComments(read(p))]);
  for (const p of ofType(".html", ".js")) {
    const inline = [...read(p).matchAll(/style\s*=\s*(["'`])([\s\S]*?)\1/g)].map((m) => m[2]).join(";\n");
    const styleTags = [...read(p).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
    if (inline || styleTags) out.push([rel(p), stripComments(`${inline}\n${styleTags}`)]);
  }
  return out;
}
const decls = (css, prop) => [...css.matchAll(new RegExp(`(?<![\\w-])(${prop})\\s*:\\s*([^;}]+)`, "g"))].map((m) => ({ prop: m[1], value: m[2].trim() }));

// Pure checks, exported so the test below can prove they catch what they should.
export function radiusProblems(css) {
  return decls(css, "border(?:-[a-z]+)*-radius").filter(({ value }) => !/^0(px|em|rem|%)?(\s+0(px|em|rem|%)?)*(\s*!important)?$/.test(value));
}
export function blurredShadows(css) {
  return decls(css, "box-shadow").filter(({ value }) => {
    if (/^(none|inherit|initial|unset)$/.test(value)) return false;
    return value.split(/,(?![^(]*\))/).some((s) => {
      const lengths = s.replace(/(rgba?|hsla?|var|color-mix)\([^)]*\)/g, "").match(/-?[\d.]+(px|em|rem)?/g) || [];
      return lengths.length >= 3 && parseFloat(lengths[2]) !== 0;
    });
  });
}
const BANNED_FONTS = /\b(Inter|Roboto|Poppins|DM Sans|Space Grotesk|system-ui|-apple-system|Segoe UI|Helvetica Neue)\b/i;

test("the checks themselves catch what they should", () => {
  assert.equal(radiusProblems(".a { border-radius: 8px; } .b { border-top-left-radius: 50%; }").length, 2);
  assert.equal(radiusProblems(".a { border-radius: 0; } .b { border-radius: 0 0 0 0; } .c { border-radius: 0 !important; }").length, 0);
  assert.equal(blurredShadows(".a { box-shadow: 0 2px 6px rgba(0,0,0,.2); }").length, 1);
  assert.equal(blurredShadows(".a { box-shadow: inset 0 0 0 3px var(--mark); } .b { box-shadow: 4px 4px 0 #000; }").length, 0);
  assert.equal(blurredShadows(".a { box-shadow: 0 0 0 2px red, 0 1px 4px black; }").length, 1);
});

test("no rounded corners anywhere in public/ or site/", () => {
  const found = cssSources().flatMap(([f, css]) => radiusProblems(css).map((d) => `${f}: ${d.prop}: ${d.value}`));
  assert.deepEqual(found, []);
});

test("no box-shadow with a blur radius, no gradients, no backdrop or blur filters", () => {
  const found = [];
  for (const [f, css] of cssSources()) {
    for (const d of blurredShadows(css)) found.push(`${f}: box-shadow: ${d.value}`);
    if (/gradient\(/.test(css)) found.push(`${f}: gradient`);
    if (/backdrop-filter/.test(css)) found.push(`${f}: backdrop-filter`);
    if (/(?<![\w-])filter\s*:[^;]*blur\(/.test(css)) found.push(`${f}: filter blur`);
  }
  assert.deepEqual(found, []);
});

test("no banned typefaces; the visible faces are Archivo and Fraunces", () => {
  const found = cssSources().flatMap(([f, css]) =>
    decls(css, "font(?:-family)?").filter((d) => BANNED_FONTS.test(d.value)).map((d) => `${f}: ${d.prop}: ${d.value}`));
  assert.deepEqual(found, []);
  const tokens = read(join(ROOT, "public", "tokens.css"));
  assert.match(tokens, /--font-sans:\s*"Archivo"/);
  assert.match(tokens, /--font-serif:\s*"Fraunces"/);
});

test("colours are defined only in tokens.css: other stylesheets use var() only", () => {
  const found = [];
  for (const p of ofType(".css").filter((p) => !p.endsWith("tokens.css"))) {
    const css = stripComments(read(p));
    for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|(?<![\w-])(rgba?|hsla?)\(/g)) found.push(`${rel(p)}: ${m[0]}`);
  }
  assert.deepEqual(found, []);
});

test("no emoji used as icons in the pages or scripts", () => {
  const found = [];
  for (const p of ofType(".html", ".js", ".css")) {
    const lines = read(p).split("\n");
    lines.forEach((l, i) => { if (/\p{Emoji_Presentation}|️/u.test(l)) found.push(`${rel(p)}:${i + 1}`); });
  }
  assert.deepEqual(found, []);
});

test("self-hosted fonts: woff2 only, 150 KB budget, licence files alongside, no external font requests", () => {
  const fonts = walk(join(ROOT, "public", "fonts"));
  const woff2 = fonts.filter((p) => p.endsWith(".woff2"));
  assert.ok(woff2.length >= 1 && woff2.length <= 4, `font files: ${woff2.map(rel)}`);
  assert.deepEqual(fonts.filter((p) => /\.(ttf|otf|woff)$/.test(p)).map(rel), [], "only woff2 is shipped");
  const total = woff2.reduce((s, p) => s + statSync(p).size, 0);
  assert.ok(total <= 150 * 1024, `fonts total ${total} bytes, over 150 KB`);
  for (const fam of ["Archivo", "Fraunces"]) assert.match(read(join(ROOT, "public", "fonts", `OFL-${fam}.txt`)), /SIL Open Font License/);
  for (const [f, css] of cssSources()) {
    assert.doesNotMatch(css, /@import|url\(\s*["']?(https?:)?\/\//, `${f} loads something from another origin`);
  }
  for (const p of ofType(".html")) assert.doesNotMatch(read(p), /fonts\.(googleapis|gstatic)\.com|<link[^>]+href=["']https?:/, rel(p));
});

test("every shell file the vendor page links is in the service worker's cache list", () => {
  const sw = read(join(ROOT, "public", "sw.js"));
  const shell = JSON.parse(/const SHELL = (\[[\s\S]*?\]);/.exec(sw)[1].replace(/,\s*\]/, "]"));
  const index = read(join(ROOT, "public", "index.html"));
  const linked = [...index.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);
  const fonts = [...read(join(ROOT, "public", "tokens.css")).matchAll(/url\("(\/[^"]+)"\)/g)].map((m) => m[1]);
  for (const u of [...linked, ...fonts]) assert.ok(shell.includes(u), `${u} is not in sw.js SHELL`);
});
