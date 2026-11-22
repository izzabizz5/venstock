// WCAG contrast for every foreground/background pair declared in public/tokens.css (its "@pair --fg on --bg kind"
// lines), in light AND dark. body = 4.5:1, large and ui = 3:1. Also: every colour token style.css uses as a text
// colour must be declared as the foreground of some pair, so a new text colour can't skip the check.
// Part of test:fast (reads files only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS = readFileSync(join(ROOT, "public", "tokens.css"), "utf8");
const MIN = { body: 4.5, large: 3, ui: 3 };

// Custom properties declared in the first block whose selector matches.
function block(css, selectorRe) {
  const m = selectorRe.exec(css);
  assert.ok(m, `tokens.css has no block for ${selectorRe}`);
  const body = css.slice(m.index + m[0].length, css.indexOf("}", m.index));
  const out = {};
  for (const d of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}
export const themes = () => {
  const light = block(TOKENS, /:root\s*\{/);
  const dark = { ...light, ...block(TOKENS, /:root\[data-theme="dark"\]\s*\{/) };
  return { light, dark };
};
function resolve(vars, name, seen = []) {
  if (seen.includes(name)) throw new Error(`token cycle: ${[...seen, name].join(" -> ")}`);
  const v = vars[name];
  if (v === undefined) throw new Error(`unknown token ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  return ref ? resolve(vars, ref[1], [...seen, name]) : v;
}
const luminance = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const pairs = [...TOKENS.matchAll(/@pair\s+(--[\w-]+)\s+on\s+(--[\w-]+)\s+(\w+)/g)].map(([, fg, bg, kind]) => ({ fg, bg, kind }));

test("the contrast maths matches known values", () => {
  assert.equal(ratio("#000000", "#FFFFFF").toFixed(2), "21.00");
  assert.equal(ratio("#FFFFFF", "#FFFFFF").toFixed(2), "1.00");
  assert.ok(ratio("#4A87D6", "#F6F4D6") < 4.5, "mid blue on cream is too weak for body text (a check that can fail)");
});

test("tokens.css declares pairs, and every kind is known", () => {
  assert.ok(pairs.length >= 15, `only ${pairs.length} pairs declared`);
  for (const p of pairs) assert.ok(p.kind in MIN, `unknown kind "${p.kind}" in @pair ${p.fg} on ${p.bg}`);
});

for (const [theme, vars] of Object.entries(themes())) {
  test(`every declared pair meets WCAG AA in ${theme} mode`, () => {
    const failures = [];
    for (const { fg, bg, kind } of pairs) {
      const r = ratio(resolve(vars, fg), resolve(vars, bg));
      if (r < MIN[kind]) failures.push(`${fg} (${resolve(vars, fg)}) on ${bg} (${resolve(vars, bg)}): ${r.toFixed(2)} < ${MIN[kind]} (${kind})`);
    }
    assert.deepEqual(failures, []);
  });
}

test("every token used as a text colour is the foreground of a declared pair", () => {
  const declared = new Set(pairs.map((p) => p.fg));
  const files = ["public/style.css", "site/public/site.css"].filter((f) => existsSync(join(ROOT, f)));
  const missing = [];
  for (const f of files) {
    const css = readFileSync(join(ROOT, f), "utf8");
    for (const m of css.matchAll(/(?<![\w-])color\s*:\s*var\((--[\w-]+)\)/g)) {
      if (!declared.has(m[1])) missing.push(`${f}: color: var(${m[1]})`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
