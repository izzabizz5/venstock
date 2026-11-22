// Support sessions: a platform admin looks at ONE vendor's data, read-only, for at most 30 minutes, with a reason,
// and every step lands in the audit log. The session lives on that vendor's own host and is useless anywhere else.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, rawRequest, USERS, PLATFORM_ADMIN } from "./harness.mjs";

const ACME = { email: "owner@acme.test", password: "test-password-acme", totpSecret: "MFRGGZDFMZTWQ2LK", isAdmin: true };
let server, admin;

before(async () => {
  server = await startServer({
    vendors: [
      { slug: "demo", users: [USERS.admin], seedSql: "INSERT INTO items (name, price_cents, stock) VALUES ('demo-marker', 100, 5);" },
      { slug: "acme", users: [ACME], seedSql: "INSERT INTO items (name, price_cents, stock) VALUES ('acme-marker', 200, 7);" },
      { slug: "closed", status: "suspended" },
    ],
    platformAdmins: [PLATFORM_ADMIN],
  });
  admin = server.client("admin.localhost");
  await admin.login(PLATFORM_ADMIN);
});
after(async () => { await server?.stop(); });

const at = (host, path, extra = {}) => rawRequest(server.port, { host, path, ...extra });
const auditActions = () => server.query("CONTROL", "SELECT action, detail, tenant_id FROM audit_log ORDER BY id");
const startSupport = async (slug, reason = "Vendor reports missing sales after the fair") => {
  const r = await admin.post("/api/platform/support", { slug, reason });
  assert.equal(r.status, 200, r.text);
  return { ...r.json, code: new URL(r.json.url).hash.replace("#support=", "") };
};
// Uses the one-time link at a host; returns the support cookie (or the failed response).
async function enter(host, code) {
  const r = await at(host, "/api/support/enter", { method: "POST", body: { code }, headers: { "user-agent": "support-test/1" } });
  const set = [].concat(r.headers["set-cookie"] || [])[0] || "";
  return { r, set, cookie: set.split(";")[0] };
}

test("starting needs a reason and an active vendor; the link points at that vendor's own host", async () => {
  assert.equal((await admin.post("/api/platform/support", { slug: "demo", reason: "" })).status, 400);
  assert.equal((await admin.post("/api/platform/support", { slug: "demo", reason: "hi" })).status, 400);
  assert.equal((await admin.post("/api/platform/support", { slug: "closed", reason: "Looking at a suspended shop" })).status, 404);
  assert.equal((await admin.post("/api/platform/support", { slug: "nosuch", reason: "Looking at nothing at all" })).status, 404);
  const s = await startSupport("demo");
  assert.match(s.url, new RegExp(`^http://demo\\.localhost:${server.port}/#support=[A-Za-z0-9_-]{32}$`));
  assert.ok(s.expires_at - Date.now() > 29 * 60_000 && s.expires_at - Date.now() <= 30 * 60_000);
  assert.deepEqual(auditActions().at(-1), { action: "support.start", detail: "Vendor reports missing sales after the fair", tenant_id: 1 });
  const vendorAdmin = server.client("demo.localhost");
  await vendorAdmin.login(USERS.admin);
  assert.equal((await vendorAdmin.post("/api/platform/support", { slug: "demo", reason: "Starting from a vendor host" })).status, 404,
    "starting is only possible at the admin host, even for a vendor's admin");
});

test("a link tried at another vendor's host is refused there and ends its session for good", async () => {
  const s = await startSupport("demo");
  const wrongHost = await enter("acme.localhost", s.code);
  assert.equal(wrongHost.r.status, 400);
  assert.equal(wrongHost.set, "");
  const refused = auditActions().at(-1);
  assert.equal(refused.action, "support.enter.refused");
  assert.equal(refused.tenant_id, 2, "recorded against the host it was tried at");
  assert.match(refused.detail, /^link is for tenant 1; session ended; ip \S+, ua support-test\/1$/);
  assert.equal((await enter("demo.localhost", s.code)).r.status, 400, "the leaked link no longer works at its own host");
  assert.deepEqual(server.query("CONTROL", `SELECT code_hash, ended_by FROM support_sessions WHERE id = ${s.id}`),
    [{ code_hash: null, ended_by: "wrong-host" }]);
});

test("the link works once, only at its own vendor's host, and sets a host-only __Host-pos_support cookie", async () => {
  const s = await startSupport("demo");
  const ok = await enter("demo.localhost", s.code);
  assert.equal(ok.r.status, 200);
  const entered = auditActions().at(-1);
  assert.equal(entered.action, "support.enter");
  assert.match(entered.detail, /^ip \S+, ua support-test\/1$/, "who used the link is recorded");
  assert.match(ok.set, /^__Host-pos_support=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=(17\d\d|1800)$/);
  assert.equal((await enter("demo.localhost", s.code)).r.status, 400, "a second use is refused");
  assert.equal((await enter("demo.localhost", "x".repeat(32))).r.status, 400);
});

test("in a support session: reads work, the app is told it's support, and every request is audited", async () => {
  const vendorSessions = server.query("DB_T1", "SELECT count(*) AS n FROM sessions")[0].n;
  const { cookie } = await enter("demo.localhost", (await startSupport("demo")).code);
  const items = await at("demo.localhost", "/api/items", { headers: { cookie } });
  assert.equal(items.status, 200);
  assert.equal(items.headers["cache-control"], "no-store", "vendor data is never kept in the staff browser's cache");
  assert.deepEqual(items.json.map((i) => i.name), ["demo-marker"]);
  assert.equal((await at("demo.localhost", "/api/export", { headers: { cookie } })).headers["cache-control"], "no-store");
  const me = await at("demo.localhost", "/api/auth/me", { headers: { cookie } });
  assert.equal(me.json.support.admin_email, PLATFORM_ADMIN.email);
  assert.equal(me.json.is_admin, true);
  assert.equal((await at("demo.localhost", "/api/users", { headers: { cookie } })).status, 200, "a read-only admin view");
  const requests = auditActions().filter((a) => a.action === "support.request").map((a) => a.detail);
  assert.ok(requests.includes("GET /api/items") && requests.includes("GET /api/auth/me"));
  assert.equal(server.query("DB_T1", "SELECT count(*) AS n FROM sessions")[0].n, vendorSessions, "never a session in the vendor's database");
});

test("in a support session nothing can be changed: every write is 403, audited, and writes nothing", async () => {
  const { cookie } = await enter("demo.localhost", (await startSupport("demo")).code);
  const before = server.query("DB_T1", "SELECT id, name, stock FROM items ORDER BY id");
  const secret = "customer note that must not be logged";
  for (const [method, path, body] of [["POST", "/api/items", { name: "Sneaky", price_cents: 1, stock: 1, notes: secret }],
    ["PUT", "/api/items/1", { name: "Changed", price_cents: 1, stock: 99, active: true }], ["POST", "/api/items/restock", { items: [{ id: 1, qty: 5 }] }],
    ["POST", "/api/users", { email: "intruder@x.test", is_admin: true }], ["DELETE", "/api/users/1"], ["POST", "/api/auth/logout", {}],
    ["POST", "/api/sales", { client_id: "3f2b8c1e-9d4a-4c7b-8e2f-1a2b3c4d5e6f", payment_method: "cash", items: [{ item_id: 1, qty: 1 }] }]]) {
    const r = await at("demo.localhost", path, { method, body, headers: { cookie } });
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  assert.deepEqual(server.query("DB_T1", "SELECT id, name, stock FROM items ORDER BY id"), before);
  assert.equal(server.query("DB_T1", "SELECT count(*) AS n FROM users")[0].n, 1);
  assert.equal(server.query("DB_T1", "SELECT count(*) AS n FROM sales")[0].n, 0);
  const denied = auditActions().filter((a) => a.action === "support.denied").map((a) => a.detail);
  assert.ok(denied.includes("POST /api/items") && denied.includes("DELETE /api/users/1"));
  assert.ok(!JSON.stringify(auditActions()).includes(secret), "request bodies never reach the audit log");
});

test("a support cookie is useless at any other vendor and at the admin host", async () => {
  const { cookie } = await enter("demo.localhost", (await startSupport("demo")).code);
  const atAcme = await at("acme.localhost", "/api/items", { headers: { cookie } });
  assert.equal(atAcme.status, 401);
  assert.doesNotMatch(atAcme.text, /marker/);
  assert.equal((await at("admin.localhost", "/api/platform/vendors", { headers: { cookie } })).status, 401);
  const token = cookie.split("=")[1];
  assert.equal((await at("demo.localhost", "/api/items", { headers: { cookie: `__Host-pos_session=${token}` } })).status, 401,
    "nor is its value a vendor session");
});

test("sessions end: after 30 minutes, when the admin ends them, and from the vendor host's End button", async () => {
  const s1 = await startSupport("demo");
  const a = await enter("demo.localhost", s1.code);
  server.query("CONTROL", `UPDATE support_sessions SET expires_at = ${Date.now() - 1000} WHERE id = ${s1.id}`);
  const expired = await at("demo.localhost", "/api/items", { headers: { cookie: a.cookie } });
  assert.equal(expired.status, 401);
  assert.match([].concat(expired.headers["set-cookie"])[0], /^__Host-pos_support=; .*Max-Age=0$/, "the cookie is cleared");

  const s2 = await startSupport("demo");
  const b = await enter("demo.localhost", s2.code);
  assert.equal((await admin.post(`/api/platform/support/${s2.id}/end`, {})).status, 200);
  assert.equal((await at("demo.localhost", "/api/items", { headers: { cookie: b.cookie } })).status, 401);

  const s3 = await startSupport("demo");
  const c = await enter("demo.localhost", s3.code);
  assert.equal((await at("demo.localhost", "/api/support/end", { method: "POST", body: {}, headers: { cookie: c.cookie } })).status, 200);
  assert.equal((await at("demo.localhost", "/api/items", { headers: { cookie: c.cookie } })).status, 401);
  const ended = server.query("CONTROL", `SELECT id, ended_by FROM support_sessions WHERE id IN (${s2.id}, ${s3.id}) ORDER BY id`);
  assert.deepEqual(ended, [{ id: s2.id, ended_by: "admin" }, { id: s3.id, ended_by: "vendor-host" }]);
  // An unused link also stops working once its session has ended.
  const s4 = await startSupport("demo");
  await admin.post(`/api/platform/support/${s4.id}/end`, {});
  assert.equal((await enter("demo.localhost", s4.code)).r.status, 400);
});

test("the admin sees sessions and the audit log; the vendor's own users are unaffected throughout", async () => {
  const sessions = (await admin.get("/api/platform/support")).json;
  assert.ok(sessions.length >= 5);
  assert.ok(sessions.every((s) => s.slug === "demo" && s.admin_email === PLATFORM_ADMIN.email));
  const log = (await admin.get("/api/platform/audit")).json;
  for (const action of ["support.start", "support.enter", "support.enter.refused", "support.request", "support.denied", "support.end"]) {
    assert.ok(log.some((l) => l.action === action), action);
  }
  await server.client("demo.localhost").login(USERS.admin);
  await server.client("acme.localhost").login(ACME);
});
