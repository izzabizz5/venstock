// The platform admin at admin.localhost: its own login (control database, __Host-pos_platform), separate from every
// vendor's. Vendor logins never work there, platform logins never work at a vendor, and neither cookie means
// anything on the other host.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, rawRequest, USERS, PLATFORM_ADMIN } from "./harness.mjs";
import { sha256, normalizeInvite } from "../src/lib/auth.js";

const INVITE = "PLAT-FORM-2345";
let server, admin, demo;

before(async () => {
  server = await startServer({
    vendors: [{ slug: "demo", users: [USERS.admin], seedSql: "INSERT INTO items (name, price_cents, stock) VALUES ('demo-marker', 100, 1);" }, { slug: "acme" }],
    platformAdmins: [PLATFORM_ADMIN],
  });
  const hash = await sha256(normalizeInvite(INVITE));
  server.query("CONTROL", `INSERT INTO platform_admins (email, invite_hash, invite_expires, created_at) VALUES ('new@venstock.test', '${hash}', ${Date.now() + 86400000}, 'x')`);
  admin = server.client("admin.localhost");
  demo = server.client("demo.localhost");
  await demo.login(USERS.admin);
});
after(async () => { await server?.stop(); });

const at = (host, path, extra = {}) => rawRequest(server.port, { host, path, ...extra });

test("admin.localhost serves the admin page; vendor hosts serve the vendor app and never the admin page", async () => {
  const page = await at("admin.localhost", "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Venstock admin<\/title>/);
  assert.equal((await at("admin.localhost", "/admin.js")).status, 200);
  assert.match((await at("demo.localhost", "/")).text, /<title>Venstock<\/title>/);
  for (const p of ["/admin", "/admin.html", "/admin.js"]) assert.equal((await at("demo.localhost", p)).status, 404, p);
});

test("platform login: password then 6-digit code; the cookie is __Host-pos_platform, host-only", async () => {
  const pw = await admin.post("/api/auth/login", { email: PLATFORM_ADMIN.email, password: PLATFORM_ADMIN.password });
  assert.equal(pw.status, 200);
  const [set] = [].concat(pw.headers["set-cookie"]);
  assert.match(set, /^__Host-pos_platform=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  await admin.login(PLATFORM_ADMIN);
  const me = await admin.get("/api/auth/me");
  assert.deepEqual(me.json, { email: PLATFORM_ADMIN.email, is_admin: true, stage: "ok" });
  assert.equal(server.query("CONTROL", "SELECT count(*) AS n FROM platform_sessions")[0].n > 0, true);
  assert.equal(server.query("DB_T1", "SELECT count(*) AS n FROM users WHERE email = '" + PLATFORM_ADMIN.email + "'")[0].n, 0);
});

test("the registry is visible to a logged-in platform admin; vendor data is not", async () => {
  const v = await admin.get("/api/platform/vendors");
  assert.equal(v.status, 200);
  assert.deepEqual(v.json.map((t) => t.slug), ["demo", "acme"]);
  for (const p of ["/api/items", "/api/sales/unassigned", "/api/users", "/api/settings", "/api/export"]) {
    assert.equal((await admin.get(p)).status, 404, `admin host ${p}`);
  }
  assert.doesNotMatch(JSON.stringify(v.json), /demo-marker/);
});

test("platform routes need a full platform login", async () => {
  assert.equal((await at("admin.localhost", "/api/platform/vendors")).status, 401);
  const half = server.client("admin.localhost");
  assert.equal((await half.post("/api/auth/login", { email: PLATFORM_ADMIN.email, password: PLATFORM_ADMIN.password })).status, 200);
  assert.equal((await half.get("/api/platform/vendors")).status, 401, "password only, no 6-digit code yet");
});

test("vendor logins don't work at admin.localhost, and platform logins don't work at a vendor (same answer as a wrong password)", async () => {
  const wrong = await server.client("admin.localhost").post("/api/auth/login", { email: PLATFORM_ADMIN.email, password: "wrong-wrong-wrong" });
  const vendorAtAdmin = await server.client("admin.localhost").post("/api/auth/login", { email: USERS.admin.email, password: USERS.admin.password });
  assert.equal(vendorAtAdmin.status, 400);
  assert.deepEqual(vendorAtAdmin.json, wrong.json);
  const platformAtDemo = await server.client("demo.localhost").post("/api/auth/login", { email: PLATFORM_ADMIN.email, password: PLATFORM_ADMIN.password });
  assert.equal(platformAtDemo.status, 400);
  assert.equal(platformAtDemo.headers["set-cookie"], undefined);
});

test("neither session cookie means anything on the other host", async () => {
  const platformCookie = `__Host-pos_platform=${admin.cookies["__Host-pos_platform"]}`;
  const vendorCookie = `__Host-pos_session=${demo.cookies["__Host-pos_session"]}`;
  // The platform token copied into the vendor cookie name, and vice versa.
  const asVendor = `__Host-pos_session=${admin.cookies["__Host-pos_platform"]}`;
  const asPlatform = `__Host-pos_platform=${demo.cookies["__Host-pos_session"]}`;
  for (const cookie of [platformCookie, asVendor]) {
    assert.equal((await at("demo.localhost", "/api/items", { headers: { cookie } })).status, 401, cookie.split("=")[0]);
  }
  for (const cookie of [vendorCookie, asPlatform]) {
    assert.equal((await at("admin.localhost", "/api/platform/vendors", { headers: { cookie } })).status, 401, cookie.split("=")[0]);
  }
});

test("the forgery rules hold on the admin host too", async () => {
  const body = { email: PLATFORM_ADMIN.email, password: PLATFORM_ADMIN.password };
  assert.equal((await at("admin.localhost", "/api/auth/login", { method: "POST", body, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await at("admin.localhost", "/api/auth/login", { method: "POST", body, headers: { "sec-fetch-site": "same-site" } })).status, 403);
  const cookie = `__Host-pos_platform=${admin.cookies["__Host-pos_platform"]}`;
  const forged = await at("admin.localhost", "/api/auth/logout", { method: "POST", body: {}, headers: { cookie, "sec-fetch-site": "same-site" } });
  assert.equal(forged.status, 403);
  assert.equal((await admin.get("/api/platform/vendors")).status, 200, "the forged logout did nothing");
});

test("a platform admin invite (create-platform-admin) signs up at admin.localhost", async () => {
  const c = server.client("admin.localhost");
  const r = await c.post("/api/auth/signup", { email: "new@venstock.test", invite: INVITE, password: "a-long-enough-password" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.stage, "mfa_setup");
  const setup = await c.post("/api/auth/mfa/setup", {});
  assert.match(setup.json.uri, /^otpauth:\/\/totp\/Venstock%20admin%3Anew%40venstock\.test\?secret=[A-Z2-7]+&issuer=Venstock%20admin&/);
  assert.equal((await server.client("demo.localhost").post("/api/auth/signup", { email: "new@venstock.test", invite: INVITE, password: "a-long-enough-password" })).status, 400,
    "a platform invite means nothing at a vendor");
});
