// The lockdown, checked in the source: request handlers can only ever reach the one vendor database the hostname
// resolved to. They never see env, so they can't reach CONTROL or another vendor's binding.
//   - src/worker.js   reads env.ASSETS and hands env to the resolver and the support-session functions; calls handleApi
//                     with { request, db, tenant, params } (plus a read-only db and `support` in a support session),
//                     and handlePlatformApi with { request, db, params } (db = the control database, admin host only)
//   - src/lib/tenant.js   the only dynamic env[...] read (the vendor binding), plus env.BASE_DOMAIN
//   - src/lib/control.js  the only code that touches CONTROL
//   - src/platform.js     platform handlers: never env, never a vendor binding
// Comments are stripped first, so these rules apply to code only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = readdirSync(SRC, { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => f.split("\\").join("/")).sort();

// Removes // and /* */ comments, leaving strings alone (a "//" inside a string is not a comment).
function code(file) {
  const s = readFileSync(join(SRC, file), "utf8");
  let out = "", i = 0, q = null;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (q) { out += c; if (c === "\\") { out += n ?? ""; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === "'" || c === '"' || c === "`") { q = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i = s.indexOf("*/", i + 2) + 2; continue; }
    out += c; i++;
  }
  return out;
}
const SOURCES = Object.fromEntries(files.map((f) => [f, code(f)]));
const using = (re) => files.filter((f) => re.test(SOURCES[f]));
const props = (f, re) => [...new Set([...SOURCES[f].matchAll(re)].map((m) => m[1]))].sort();

test("the source files are the ones these rules were written for", () => {
  assert.deepEqual(files, ["api.js", "lib/auth.js", "lib/control.js", "lib/readonly-db.js", "lib/redact.js", "lib/sales.js", "lib/tenant.js", "lib/validate.js",
    "platform.js", "worker.js"],
    "a new src file: decide which of the rules below applies to it, then update this list");
});

test("only the Worker, the resolver and the registry module mention env at all", () => {
  assert.deepEqual(using(/\benv\b/), ["lib/control.js", "lib/tenant.js", "worker.js"]);
});

test("only the resolver reads a binding dynamically (env[...]), and only the derived one", () => {
  assert.deepEqual(using(/\benv\s*\[/), ["lib/tenant.js"]);
  assert.deepEqual([...SOURCES["lib/tenant.js"].matchAll(/\benv\s*\[([^\]]*)\]/g)].map((m) => m[1]), ["binding"]);
  assert.match(SOURCES["lib/tenant.js"], /const binding = vendorBinding\(row\.id\);/);
});

test("only control.js touches CONTROL; vendor handler modules import none of control, tenant or platform", () => {
  assert.deepEqual(using(/\bCONTROL\b/), ["lib/control.js"]);
  assert.deepEqual(props("lib/control.js", /\benv\.(\w+)/g), ["CONTROL"]);
  assert.deepEqual(using(/from\s+["'][./]*(lib\/)?control\.js["']/), ["lib/tenant.js", "platform.js", "worker.js"]);
  assert.deepEqual([...SOURCES["platform.js"].matchAll(/import \{([^}]*)\} from "\.\/lib\/control\.js"/g)].map((m) => m[1].trim()), ["SUPPORT_MINUTES, LINK_SECONDS"],
    "platform.js takes only a constant from control.js (it has no env to call anything with)");
  for (const f of ["api.js", "lib/auth.js", "lib/sales.js", "lib/validate.js", "lib/readonly-db.js", "lib/redact.js"]) {
    assert.doesNotMatch(SOURCES[f], /from\s+["'][./]*(lib\/)?(control|tenant)\.js["']|platform\.js/, f);
  }
});

test("the Worker reads only env.ASSETS itself; the resolver only env.BASE_DOMAIN", () => {
  assert.deepEqual(props("worker.js", /\benv\.(\w+)/g), ["ASSETS"]);
  assert.deepEqual(props("lib/tenant.js", /\benv\.(\w+)/g), ["BASE_DOMAIN"]);
});

test("vendor handlers get exactly { request, db, tenant, params } (support: a read-only db plus who is looking)", () => {
  const calls = [...SOURCES["worker.js"].matchAll(/handleApi\((\{[^;]*?\})\)/g)].map((m) => m[1].replace(/\s+/g, " "));
  assert.deepEqual(calls, [
    "{ request, db: readOnlyDb(v.db), tenant: v.tenant, params: { route }, support: { admin_email: s.admin_email, expires_at: s.expires_at } }",
    "{ request, db: v.db, tenant: v.tenant, params: { route } }",
  ]);
  // A support session's answers always pass through the redaction of account secrets on the way out.
  assert.match(SOURCES["worker.js"], /return redactForSupport\(await handleApi\(\{ request, db: readOnlyDb\(v\.db\),/);
  assert.match(SOURCES["api.js"], /export async function handleApi\(\{ request, db, tenant, params, support = null \}\)/);
  assert.deepEqual(using(/handleApi\(/), ["api.js", "worker.js"]);
});

test("platform handlers get exactly { request, db, params }, db being the control database, on the admin host only", () => {
  const calls = [...SOURCES["worker.js"].matchAll(/handlePlatformApi\(([^;]*)\);/g)].map((m) => m[1].replace(/\s+/g, " "));
  assert.deepEqual(calls, ["{ request, db: v.db, params: { route } }"]);
  assert.match(SOURCES["worker.js"], /case "platform": \{[\s\S]*?handlePlatformApi\(/, "only inside the platform case");
  assert.match(SOURCES["lib/tenant.js"], /if \(parsed\.kind === "reserved" && parsed\.slug === "admin"\) return \{ kind: "platform", db: platformDatabase\(env\) \};/);
  assert.match(SOURCES["lib/control.js"], /export const platformDatabase = \(env\) => env\.CONTROL;/);
  assert.deepEqual(using(/handlePlatformApi\(/), ["platform.js", "worker.js"]);
  assert.doesNotMatch(SOURCES["platform.js"], /\benv\b/);
});

test("support sessions: anything but GET is refused before a handler runs, and the handler's db is read-only", () => {
  const w = SOURCES["worker.js"];
  const i = w.indexOf("const s = await supportSession(env, supportToken, v.tenant.id);");
  const j = w.indexOf("db: readOnlyDb(v.db)");
  assert.ok(i > 0 && j > i);
  assert.match(w.slice(i, j), /if \(request\.method !== "GET"\) \{[\s\S]*?status: 403/);
});

test("no code refers to the old shared DB binding", () => {
  assert.deepEqual(using(/\bDB\b(?!_)/), []);
});

test("server errors never echo error details to the browser", () => {
  for (const f of files) {
    assert.doesNotMatch(SOURCES[f], /fail\([^)]*e(rr)?\.message/, `${f}: an error message passed to fail()`);
    assert.doesNotMatch(SOURCES[f], /fail\(\s*String\(\s*e\b/, `${f}: an error passed to fail()`);
  }
  assert.match(SOURCES["api.js"], /return fail\("Something went wrong", 500\);/);
});
