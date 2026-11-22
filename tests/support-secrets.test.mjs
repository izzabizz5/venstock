// Under a support session, no GET route returns anything usable to take over an account: password hashes,
// authenticator secrets or setup links, invite codes or their hashes, session tokens or their hashes, or the support
// session's own code and token. The route list must cover every GET handler in the source (counted below), so a new
// GET route can't be added without being checked here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { startServer, rawRequest, USERS, PLATFORM_ADMIN } from "./harness.mjs";
import { sha256, normalizeInvite } from "../src/lib/auth.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INVITE = "SECR-ETIN-VITE";
// Every GET handler, by the source line that guards it (see the count test), and a request that reaches it.
const ROUTES = {
  "auth/me (support)": "/api/auth/me",
  "users list": "/api/users",
  "items list": "/api/items?all=1",
  "items export": "/api/items/export",
  "settings": "/api/settings",
  "upcoming shows": "/api/shows/upcoming",
  "shows list": "/api/shows",
  "active show": "/api/shows/active",
  "show summary": "/api/shows/1/summary",
  "show sales": "/api/shows/1/sales",
  "unassigned sales": "/api/sales/unassigned",
  "sales export": "/api/export",
};
// GET handlers that a support session can't reach at all (answered 403 before any handler): the vendor login's own
// /auth/me. Listed so the count below stays honest.
const UNREACHABLE_IN_SUPPORT = ["auth/me (vendor login)"];

let server, cookie, secrets;

before(async () => {
  const inviteHash = await sha256(normalizeInvite(INVITE));
  server = await startServer({
    vendors: [{ slug: "demo", users: [USERS.admin, USERS.staff], seedSql: `
      INSERT INTO items (id, name, price_cents, stock) VALUES (1, 'Tee', 500, 10);
      INSERT INTO shows (id, name, started_at) VALUES (1, 'Fair', '2026-11-21T10:00:00Z');
      INSERT INTO upcoming_shows (name, show_date, start_time, end_time) VALUES ('Next', '2026-12-01', '', '');
      INSERT INTO users (email, is_admin, invite_hash, invite_expires, created_at) VALUES ('invited@demo.test', 0, '${inviteHash}', ${Date.now() + 86400000}, 'x');` }],
    platformAdmins: [PLATFORM_ADMIN],
  });
  const owner = server.client("demo.localhost");
  await owner.login(USERS.admin);
  await owner.post("/api/sales", { client_id: randomUUID(), payment_method: "cash", show_id: 1, items: [{ item_id: 1, qty: 1 }] });
  await owner.post("/api/sales", { client_id: randomUUID(), payment_method: "zelle", items: [{ item_id: 1, qty: 2 }] });
  const vendorToken = owner.cookies["__Host-pos_session"];

  const admin = server.client("admin.localhost");
  await admin.login(PLATFORM_ADMIN);
  const start = await admin.post("/api/platform/support", { slug: "demo", reason: "Checking that support sees no secrets" });
  const code = new URL(start.json.url).hash.replace("#support=", "");
  const entered = await rawRequest(server.port, { host: "demo.localhost", method: "POST", path: "/api/support/enter", body: { code } });
  cookie = [].concat(entered.headers["set-cookie"])[0].split(";")[0];

  const users = server.query("DB_T1", "SELECT password_hash, totp_secret, invite_hash FROM users");
  secrets = [
    USERS.admin.password, USERS.staff.password, USERS.admin.totpSecret, USERS.staff.totpSecret, INVITE, normalizeInvite(INVITE), inviteHash,
    vendorToken, await sha256(vendorToken), code, await sha256(code), cookie.split("=")[1], await sha256(cookie.split("=")[1]),
    ...users.flatMap((u) => [u.password_hash, u.totp_secret, u.invite_hash]),
    ...server.query("DB_T1", "SELECT id FROM sessions").map((s) => s.id),
  ].filter(Boolean);
  assert.ok(secrets.length >= 15);
});
after(async () => { await server?.stop(); });

test("the route list covers every GET handler in the vendor API", () => {
  const count = (f) => (readFileSync(join(ROOT, f), "utf8").match(/m === "GET"/g) || []).length;
  const handlers = count("src/api.js") + count("src/lib/auth.js");
  assert.equal(Object.keys(ROUTES).length + UNREACHABLE_IN_SUPPORT.length, handlers,
    "a GET handler was added or removed: add it to ROUTES (or UNREACHABLE_IN_SUPPORT) in this test");
});

test("every GET route works under a support session and returns no account secret", async () => {
  for (const [name, path] of Object.entries(ROUTES)) {
    const r = await rawRequest(server.port, { host: "demo.localhost", path, headers: { cookie } });
    assert.equal(r.status, 200, `${name}: ${r.text}`);
    for (const s of secrets) assert.ok(!r.text.includes(s), `${name} leaks a secret (${s.slice(0, 6)}…)`);
    assert.doesNotMatch(r.text, /password_hash|totp_secret|invite_hash|otpauth:|session_id|"invite"|"token"/i, name);
    assert.equal(r.headers["set-cookie"], undefined, `${name} sets no cookie`);
  }
});

test("the vendor login's own routes are closed to a support session", async () => {
  for (const [method, path, body] of [["GET", "/api/auth/mfa/setup"], ["GET", "/api/account/support-sessions"],
    ["POST", "/api/auth/mfa/setup", {}], ["POST", "/api/users", { email: "x@y.test" }],
    ["POST", "/api/users/2/invite", {}]]) {
    const r = await rawRequest(server.port, { host: "demo.localhost", method, path, body, headers: { cookie } });
    assert.ok([403, 404].includes(r.status), `${method} ${path}: ${r.status}`);
    for (const s of secrets) assert.ok(!r.text.includes(s));
  }
});
