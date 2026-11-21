// Logins and sessions belong to one vendor: they live in that vendor's own database, so a user, a cookie, a
// half-finished login or an invite from one vendor means nothing at another.
// demo = tenant 1 (USERS.admin), acme = tenant 2 (ACME), twin = tenant 3 (a DIFFERENT user with demo admin's email).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, rawRequest, USERS } from "./harness.mjs";
import { sha256, normalizeInvite, totpCode } from "../src/lib/auth.js";

const ACME = { email: "owner@acme.test", password: "test-password-acme", totpSecret: "MFRGGZDFMZTWQ2LK", isAdmin: true };
const TWIN = { email: USERS.admin.email, password: "a-different-password-twin", totpSecret: "GEZDGNBVGY3TQOJQ", isAdmin: true };
const INVITE = "K7QM-3XPA-ZR9T";
const INVITED = "new-hire@acme.test";
let server;

before(async () => {
  const inviteHash = await sha256(normalizeInvite(INVITE));
  server = await startServer({ vendors: [
    { slug: "demo", users: [USERS.admin] },
    { slug: "acme", users: [ACME], seedSql: `INSERT INTO users (email, is_admin, invite_hash, invite_expires, created_at)
      VALUES ('${INVITED}', 0, '${inviteHash}', ${Date.now() + 86400000}, '2026-11-21T00:00:00Z');` },
    { slug: "twin", users: [TWIN] },
  ] });
});
after(async () => { await server?.stop(); });

const loginBody = (u, extra = {}) => ({ email: u.email, password: u.password, ...extra });
const userRow = (binding, email) => server.query(binding, `SELECT failed_logins, locked_until FROM users WHERE email = '${email}'`)[0];

test("each vendor's users log in on their own subdomain", async () => {
  await server.client("demo.localhost").login(USERS.admin);
  await server.client("acme.localhost").login(ACME);
  await server.client("twin.localhost").login(TWIN);
});

test("a user cannot log in on another vendor's subdomain (same answer as a wrong password, no cookie)", async () => {
  const atAcme = await server.client("acme.localhost").post("/api/auth/login", loginBody(USERS.admin));
  const wrongPw = await server.client("demo.localhost").post("/api/auth/login", { email: USERS.admin.email, password: "wrong-wrong-wrong" });
  assert.equal(atAcme.status, 400);
  assert.deepEqual(atAcme.json, wrongPw.json, "must not reveal that the email exists at another vendor");
  assert.equal(atAcme.headers["set-cookie"], undefined);
  assert.equal((await server.client("demo.localhost").post("/api/auth/login", loginBody(ACME))).status, 400);
});

test("the same email at two vendors is two separate accounts: each password works only at its own vendor", async () => {
  assert.equal((await server.client("twin.localhost").post("/api/auth/login", loginBody(USERS.admin))).status, 400, "demo's password at twin");
  assert.equal((await server.client("demo.localhost").post("/api/auth/login", loginBody(TWIN))).status, 400, "twin's password at demo");
  const demo = server.client("demo.localhost");
  await demo.login(USERS.admin);
  const twinCookie = { cookie: `pos_session=${demo.cookies.pos_session}` };
  assert.equal((await rawRequest(server.port, { host: "twin.localhost", path: "/api/auth/me", headers: twinCookie })).status, 401,
    "demo's session for that email is not a session at twin");
});

test("mass assignment: vendor fields in the login body are ignored", async () => {
  const r = await server.client("demo.localhost").post("/api/auth/login", loginBody(ACME, { tenant_id: 2, tenant: "acme", tenantId: 2, slug: "acme" }));
  assert.equal(r.status, 400, "acme's owner still can't log in at demo, whatever the body says");
});

test("a full-session cookie copied to another vendor's subdomain is not logged in there", async () => {
  const demo = server.client("demo.localhost");
  await demo.login(USERS.admin);
  assert.equal((await demo.get("/api/items")).status, 200);
  const cookie = `pos_session=${demo.cookies.pos_session}`;
  for (const path of ["/api/auth/me", "/api/items", "/api/settings", "/api/users"]) {
    const r = await rawRequest(server.port, { host: "acme.localhost", path, headers: { cookie } });
    assert.equal(r.status, 401, `acme ${path} with demo's cookie`);
  }
  const pw = await rawRequest(server.port, { host: "acme.localhost", path: "/api/auth/password", method: "POST",
    headers: { cookie }, body: { current: USERS.admin.password, password: "a-new-long-password" } });
  assert.equal(pw.status, 401);
  assert.equal((await demo.get("/api/items")).status, 200, "the cookie still works on its own vendor");
});

test("a half-finished login (password only) cannot be completed on another vendor's subdomain", async () => {
  const demo = server.client("demo.localhost");
  assert.equal((await demo.post("/api/auth/login", loginBody(USERS.admin))).status, 200);
  const cookie = `pos_session=${demo.cookies.pos_session}`;
  const code = await totpCode(USERS.admin.totpSecret, Math.floor(Date.now() / 30000) + 1);
  const mfa = await rawRequest(server.port, { host: "acme.localhost", path: "/api/auth/mfa", method: "POST", headers: { cookie }, body: { code } });
  assert.equal(mfa.status, 401);
  const setup = await rawRequest(server.port, { host: "acme.localhost", path: "/api/auth/mfa/setup", method: "POST", headers: { cookie }, body: {} });
  assert.equal(setup.status, 401);
});

test("sessions are stored only in the database of the vendor where the login happened", async () => {
  const count = (b) => server.query(b, "SELECT count(*) AS n FROM sessions")[0].n;
  const before = { demo: count("DB_T1"), acme: count("DB_T2"), twin: count("DB_T3") };
  await server.client("acme.localhost").login(ACME);
  assert.deepEqual({ demo: count("DB_T1"), acme: count("DB_T2"), twin: count("DB_T3") }, { ...before, acme: before.acme + 1 });
  assert.equal(server.query("CONTROL", "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('sessions', 'users')")[0].n, 0,
    "no vendor login data in the control database");
});

test("an invite only works on its own vendor's subdomain", async () => {
  const body = { email: INVITED, invite: INVITE, password: "a-long-enough-password" };
  const atDemo = await server.client("demo.localhost").post("/api/auth/signup", body);
  assert.equal(atDemo.status, 400);
  assert.match(atDemo.json.error, /don't match/);
  assert.deepEqual(server.query("DB_T1", `SELECT count(*) AS n FROM users WHERE email = '${INVITED}'`), [{ n: 0 }]);
  const atAcme = await server.client("acme.localhost").post("/api/auth/signup", body);
  assert.equal(atAcme.status, 200);
  assert.equal(atAcme.json.stage, "mfa_setup");
});

test("wrong passwords at another vendor's subdomain don't lock the account", async () => {
  // Earlier tests made real wrong-password attempts at demo and twin; what matters is that attempts at acme change
  // neither (and the lockout threshold is 5, so six attempts would lock a shared account).
  const before = { demo: userRow("DB_T1", USERS.admin.email), twin: userRow("DB_T3", TWIN.email) };
  assert.equal(before.demo.locked_until, 0);
  assert.equal(before.twin.locked_until, 0);
  const acme = server.client("acme.localhost");
  for (let i = 0; i < 6; i++) await acme.post("/api/auth/login", { email: USERS.admin.email, password: "wrong-wrong-wrong" });
  assert.deepEqual(userRow("DB_T1", USERS.admin.email), before.demo);
  assert.deepEqual(userRow("DB_T3", TWIN.email), before.twin, "nor the same-email account at twin");
  await server.client("demo.localhost").login(USERS.admin);
  await server.client("twin.localhost").login(TWIN);
});
