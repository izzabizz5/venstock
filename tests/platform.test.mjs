// The platform admin at admin.localhost: its own login (control database, __Host-pos_platform), separate from every
// vendor's. Vendor logins never work there, platform logins never work at a vendor, and neither cookie means
// anything on the other host.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, rawRequest, USERS, PLATFORM_ADMIN } from "./harness.mjs";
import { sha256, normalizeInvite, totpCode } from "../src/lib/auth.js";

const INVITE = "PLAT-FORM-2345";
// A second staff account for the wrong-tries tests, so locking it doesn't disturb the others.
const LOCKME = { email: "lockme@venstock.test", password: "test-password-lockme", totpSecret: "JBSWY3DPEHPK3PXP", isAdmin: true };
let server, admin, demo;

before(async () => {
  server = await startServer({
    vendors: [{ slug: "demo", users: [USERS.admin], seedSql: "INSERT INTO items (name, price_cents, stock) VALUES ('demo-marker', 100, 1);" }, { slug: "acme" }],
    platformAdmins: [PLATFORM_ADMIN, LOCKME],
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
  const forged = await at("admin.localhost", "/api/platform/support", { method: "POST", body: { slug: "demo", reason: "forged request" },
    headers: { cookie, "sec-fetch-site": "same-site" } });
  assert.equal(forged.status, 403);
  assert.equal(server.query("CONTROL", "SELECT count(*) AS n FROM support_sessions")[0].n, 0);
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

// ---------- wrong tries count per account, not per login ----------
const lockRow = () => server.query("CONTROL", `SELECT failed_logins, locked_until > ${Date.now()} AS locked FROM platform_admins WHERE email = '${LOCKME.email}'`)[0];
const unlock = () => server.query("CONTROL", `UPDATE platform_admins SET failed_logins = 0, locked_until = 0 WHERE email = '${LOCKME.email}'`);
// A 6-digit code that is certainly wrong right now (not valid for the previous, current or next 30 seconds).
async function wrongCode() {
  const now = Math.floor(Date.now() / 30000);
  const valid = await Promise.all([now - 1, now, now + 1, now + 2].map((s) => totpCode(LOCKME.totpSecret, s)));
  for (let n = 0; ; n++) { const c = String(n).padStart(6, "0"); if (!valid.includes(c)) return c; }
}
const passwordStep = (c) => c.post("/api/auth/login", { email: LOCKME.email, password: LOCKME.password });

test("logging in again doesn't buy more 6-digit guesses: five wrong codes across logins lock the account", async () => {
  unlock();
  const c = server.client("admin.localhost");
  assert.equal((await passwordStep(c)).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await c.post("/api/auth/mfa", { code: await wrongCode() })).status, 400);
  const again = server.client("admin.localhost");
  assert.equal((await passwordStep(again)).status, 200, "a correct password still opens the code step");
  assert.equal((await again.post("/api/auth/mfa", { code: await wrongCode() })).status, 400);
  const fifth = await again.post("/api/auth/mfa", { code: await wrongCode() });
  assert.equal(fifth.status, 429, "the fifth wrong code in total locks the account");
  assert.equal(lockRow().locked, 1);
  assert.equal((await c.post("/api/auth/mfa", { code: await wrongCode() })).status, 429, "the first half-finished login can't go on either");
  assert.equal((await c.get("/api/auth/me")).status, 401, "and it was thrown away");
  unlock();
});

test("codes sent all at once are all counted", async () => {
  unlock();
  const c = server.client("admin.localhost");
  assert.equal((await passwordStep(c)).status, 200);
  const code = await wrongCode();
  const answers = await Promise.all(Array.from({ length: 12 }, () => c.post("/api/auth/mfa", { code })));
  assert.ok(answers.every((r) => r.status !== 200));
  assert.ok(answers.filter((r) => r.status === 400).length <= 4, `at most 4 plain refusals, got ${answers.map((r) => r.status)}`);
  assert.equal(lockRow().locked, 1);
  unlock();
});

test("while locked, only someone with the password is told; others get the unknown-email answer", async () => {
  unlock();
  const c = server.client("admin.localhost");
  for (let i = 0; i < 5; i++) await c.post("/api/auth/login", { email: LOCKME.email, password: "wrong-wrong-wrong" });
  assert.equal(lockRow().locked, 1);
  const wrong = await c.post("/api/auth/login", { email: LOCKME.email, password: "wrong-wrong-wrong" });
  const unknown = await c.post("/api/auth/login", { email: "nobody@venstock.test", password: "wrong-wrong-wrong" });
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.json, unknown.json, "a lock must not reveal that the account exists");
  const right = await passwordStep(c);
  assert.equal(right.status, 429);
  assert.equal(right.headers["set-cookie"], undefined);
  unlock();
});

test("a complete login clears the count; a correct password alone gives its try back; sign-up guesses can't lock an active account", async () => {
  unlock();
  const c = server.client("admin.localhost");
  for (let i = 0; i < 3; i++) await c.post("/api/auth/login", { email: LOCKME.email, password: "wrong-wrong-wrong" });
  assert.equal(lockRow().failed_logins, 3);
  await passwordStep(c);
  assert.equal(lockRow().failed_logins, 3, "a correct password neither adds nor clears");
  await server.client("admin.localhost").login(LOCKME);
  assert.equal(lockRow().failed_logins, 0, "a complete login clears");
  for (let i = 0; i < 7; i++) {
    assert.equal((await c.post("/api/auth/signup", { email: LOCKME.email, invite: "AAAA-BBBB-CCCC", password: "a-long-enough-password" })).status, 400);
  }
  assert.deepEqual(lockRow(), { failed_logins: 0, locked: 0 }, "no invite waiting: nothing to guess, nothing counted");
  await server.client("admin.localhost").login(LOCKME);
});
