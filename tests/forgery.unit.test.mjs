// Same-site forgery and cookie tossing, without a server: the Worker's request check, the cookie helpers, and source
// rules that keep them in place. The real-server version is tests/forgery.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { refuseForgedRequest } from "../src/worker.js";
import { VENDOR_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE, sessionCookie, readCookie } from "../src/lib/auth.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const req = (method, headers = {}) => new Request("https://demo.example.com/api/items", { method, headers });

test("GET and HEAD are never refused (they change nothing)", () => {
  for (const m of ["GET", "HEAD"]) {
    assert.equal(refuseForgedRequest(req(m)), null);
    assert.equal(refuseForgedRequest(req(m, { "sec-fetch-site": "cross-site" })), null);
  }
});

test("every other method needs Content-Type: application/json (415 otherwise)", () => {
  for (const m of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    for (const ct of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", "text/json"]) {
      const r = refuseForgedRequest(req(m, ct ? { "content-type": ct } : {}));
      assert.equal(r?.status, 415, `${m} ${ct}`);
    }
    for (const ct of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) {
      assert.equal(refuseForgedRequest(req(m, { "content-type": ct })), null, `${m} ${ct}`);
    }
  }
});

test("a non-GET request from anywhere but the same origin is refused with 403, even as JSON", () => {
  for (const site of ["same-site", "cross-site", "none", "", "SAME-ORIGIN"]) {
    const r = refuseForgedRequest(req("POST", { "sec-fetch-site": site, "content-type": "application/json" }));
    assert.equal(r?.status, 403, JSON.stringify(site));
  }
  assert.equal(refuseForgedRequest(req("POST", { "sec-fetch-site": "same-origin", "content-type": "application/json" })), null);
  assert.equal(refuseForgedRequest(req("POST", { "content-type": "application/json" })), null, "no Sec-Fetch-Site: the JSON check decides");
});

test("the session cookies are __Host- names: Secure, HttpOnly, SameSite=Strict, Path=/, no Domain", () => {
  assert.equal(VENDOR_COOKIE, "__Host-pos_session");
  for (const name of [PLATFORM_COOKIE, SUPPORT_COOKIE]) {
    assert.match(name, /^__Host-pos_/);
    assert.doesNotMatch(sessionCookie(name, "t", 1), /domain/i);
  }
  assert.equal(new Set([VENDOR_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE]).size, 3);
  const c = sessionCookie(VENDOR_COOKIE, "tok", 60);
  assert.equal(c, "__Host-pos_session=tok; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60");
  assert.doesNotMatch(c, /domain/i);
});

test("only the exact cookie name is read: a tossed or look-alike cookie is ignored", () => {
  const r = (cookie) => readCookie(new Request("https://x.example.com/", { headers: { cookie } }), VENDOR_COOKIE);
  assert.equal(r("__Host-pos_session=good"), "good");
  assert.equal(r("pos_session=tossed; __Host-pos_session=good"), "good");
  assert.equal(r("pos_session=tossed"), undefined, "the old, unprefixed name is never read");
  assert.equal(r("x__Host-pos_session=bad"), undefined);
  assert.equal(r("__Host-pos_sessionx=bad"), undefined);
  assert.equal(r("__Host-pos_session="), undefined);
  assert.equal(r(""), undefined);
});

test("source: the check runs first in the Worker, and auth.js never sets a Domain or reads another name", () => {
  const worker = read("src/worker.js");
  assert.match(worker, /async function serve\(request, env\) \{\n  const forged = refuseForgedRequest\(request\);\n  if \(forged\) return forged;/);
  assert.match(worker, /if \(site !== null && site !== "same-origin"\)/);
  assert.match(worker, /if \(type !== "application\/json"\)/);
  const auth = read("src/lib/auth.js");
  assert.doesNotMatch(auth.replace(/\/\/.*$/gm, ""), /domain\s*=/i, "no Domain attribute anywhere in auth.js");
  assert.match(auth, /export const VENDOR_COOKIE = "__Host-pos_session";/);
  // Each realm reads only its own cookie name: vendor __Host-pos_session, platform __Host-pos_platform.
  assert.match(auth, /const readToken = \(request\) => readCookie\(request, R\.cookie\);/);
  assert.match(auth, /export const VENDOR_REALM = Object\.freeze\(\{ users: "users", sessions: "sessions", fk: "user_id", cookie: VENDOR_COOKIE,/);
  assert.match(auth, /export const PLATFORM_COOKIE = "__Host-pos_platform";/);
  assert.match(auth, /export const SUPPORT_COOKIE = "__Host-pos_support";/);
});

test("front end: the app's only API call sends application/json for every method; sync.js and sw.js only GET the shell", () => {
  const app = read("public/app.js");
  assert.equal(app.replace(/\/\/.*$/gm, "").match(/\bfetch\(/g).length, 1, "one fetch call in app.js (comments aside), inside api()");
  assert.match(app, /async function api\(path, opts = \{\}\) \{\n  const r = await fetch\("\/api\/" \+ path, \{\n    method: opts\.method \|\| "GET",\n    headers: \{ "content-type": "application\/json" \},/);
  for (const f of ["public/sync.js", "public/sw.js"]) {
    const src = read(f);
    assert.doesNotMatch(src, /method:\s*["'](POST|PUT|DELETE|PATCH)/i, `${f} makes no write requests`);
  }
  assert.match(read("public/sw.js"), /if \(e\.request\.method !== "GET" \|\| url\.pathname\.startsWith\("\/api\/"\)\) return;/);
});
