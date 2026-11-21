// Settings, shows, upcoming shows and the users admin, across two vendors. Each lives in its vendor's own database, so
// vendor A acting through its own hostname (by id, or with vendor fields in the body) must never change vendor B.
// The same staff email exists at both vendors as two different accounts.
//   demo: shows 1 (ended) and 2 (running); upcoming 1 and 2; users 1 admin, 2 staff, 3 third
//   acme: show 1 (running); upcoming 1;            users 1 owner, 2 staff (same email as demo's staff)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, USERS } from "./harness.mjs";

const ACME = { email: "owner@acme.test", password: "test-password-acme", totpSecret: "MFRGGZDFMZTWQ2LK", isAdmin: true };
const ACME_STAFF = { email: USERS.staff.email, password: "acme-staff-password-x", totpSecret: "NBSWY3DPO5XXE3DE", isAdmin: false };
const DEMO_THIRD = { email: "third@demo.test", password: "test-password-third", totpSecret: "ONSWG4TFOQYTEMZU", isAdmin: false }; // id 3: demo only
let server, demo, acme;

before(async () => {
  server = await startServer({ vendors: [
    { slug: "demo", users: [USERS.admin, USERS.staff, DEMO_THIRD], seedSql: `
      INSERT INTO shows (id, name, started_at, ended_at) VALUES (1, 'Old Fair', '2026-11-01T10:00:00Z', '2026-11-01T18:00:00Z'),
        (2, 'Demo Fair', '2026-11-21T10:00:00Z', NULL);
      INSERT INTO upcoming_shows (id, name, show_date, start_time, end_time) VALUES (1, 'Demo Next', '2026-12-01', '', ''), (2, 'Demo Later', '2026-12-08', '', '');
      INSERT INTO settings (key, value) VALUES ('registers', '4'), ('deals', '[{"qty":3,"unit_price_cents":500,"off_cents":200}]');` },
    { slug: "acme", users: [ACME, ACME_STAFF], seedSql: `
      INSERT INTO shows (id, name, started_at, ended_at) VALUES (1, 'Acme Market', '2026-11-21T09:00:00Z', NULL);
      INSERT INTO upcoming_shows (id, name, show_date, start_time, end_time) VALUES (1, 'Acme Next', '2026-12-02', '', '');` },
  ] });
  demo = server.client("demo.localhost");
  acme = server.client("acme.localhost");
  await demo.login(USERS.admin);
  await acme.login(ACME);
});
after(async () => { await server?.stop(); });

const demoState = () => ({
  settings: server.query("DB_T1", "SELECT key, value FROM settings ORDER BY key"),
  shows: server.query("DB_T1", "SELECT id, name, ended_at FROM shows ORDER BY id"),
  upcoming: server.query("DB_T1", "SELECT id, name, show_date FROM upcoming_shows ORDER BY id"),
  users: server.query("DB_T1", "SELECT id, email, is_admin, password_hash, totp_secret, invite_hash FROM users ORDER BY id"),
  sessions: server.query("DB_T1", "SELECT count(*) AS n FROM sessions")[0].n,
});
let DEMO;
test("baseline", () => { DEMO = demoState(); assert.equal(DEMO.users.length, 3); });

test("settings: each vendor reads and writes only its own", async () => {
  assert.equal((await demo.get("/api/settings")).json.registers, 4);
  assert.equal((await acme.get("/api/settings")).json.registers, 3, "acme has the defaults, not demo's");
  assert.deepEqual((await acme.get("/api/settings")).json.deals, []);
  const r = await acme.put("/api/settings", { registers: 7, deals: [{ qty: 2, unit_price_cents: 900, off_cents: 100 }], tenant_id: 1, slug: "demo" });
  assert.equal(r.status, 200);
  assert.equal((await acme.get("/api/settings")).json.registers, 7);
  assert.deepEqual(demoState().settings, DEMO.settings);
});

test("shows: lists are per vendor; starting a show at acme doesn't end demo's running show", async () => {
  assert.deepEqual((await acme.get("/api/shows")).json.map((s) => s.name), ["Acme Market"]);
  assert.equal((await acme.get("/api/shows/active")).json.name, "Acme Market");
  assert.equal((await demo.get("/api/shows/active")).json.name, "Demo Fair");
  const r = await acme.post("/api/shows", { name: "Acme Evening", tenant_id: 1 });
  assert.equal(r.status, 200);
  assert.equal((await acme.get("/api/shows/active")).json.name, "Acme Evening");
  assert.deepEqual(demoState().shows, DEMO.shows, "demo's show 2 is still running");
});

test("ending a show by an id both vendors have ends only the caller's own", async () => {
  // acme's show 1 is already ended (by starting Acme Evening); demo's show 2 is running. acme ends "2": its own id 2.
  const acmeShow2 = server.query("DB_T2", "SELECT id, name FROM shows WHERE id = 2")[0];
  assert.equal(acmeShow2.name, "Acme Evening");
  assert.equal((await acme.post("/api/shows/2/end", {})).status, 200);
  assert.notEqual(server.query("DB_T2", "SELECT ended_at FROM shows WHERE id = 2")[0].ended_at, null);
  assert.deepEqual(demoState().shows, DEMO.shows, "demo's show 2 is still running");
});

test("upcoming shows: list, edit, delete and start by an id only demo has never touch demo", async () => {
  assert.deepEqual((await acme.get("/api/shows/upcoming")).json.map((s) => s.name), ["Acme Next"]);
  const edit = { name: "Hijacked", show_date: "2026-12-31", start_time: "", end_time: "" };
  const put = await acme.put("/api/shows/upcoming/2", edit);
  const putMissing = await acme.put("/api/shows/upcoming/999", edit);
  assert.equal(put.status, 404);
  assert.equal(put.text, putMissing.text);
  assert.equal((await acme.del("/api/shows/upcoming/2")).status, 200, "deleting is idempotent: nothing there, nothing removed");
  const start = await acme.post("/api/shows/upcoming/2/start", {});
  assert.equal(start.status, 404);
  assert.deepEqual(demoState().upcoming, DEMO.upcoming);
  assert.deepEqual(demoState().shows, DEMO.shows);
});

test("users: each admin lists only their own vendor's users, even with a shared email", async () => {
  const atAcme = (await acme.get("/api/users")).json;
  assert.deepEqual(atAcme.map((u) => u.email).sort(), [ACME.email, USERS.staff.email].sort());
  const atDemo = (await demo.get("/api/users")).json;
  assert.deepEqual(atDemo.map((u) => u.email).sort(), [USERS.admin.email, USERS.staff.email, DEMO_THIRD.email].sort());
  assert.ok(!atDemo.some((u) => u.email === ACME.email));
});

test("users: reset and remove by an id only demo has (3): 404 like a missing id, demo unchanged", async () => {
  assert.deepEqual(server.query("DB_T2", "SELECT id FROM users ORDER BY id").map((r) => r.id), [1, 2], "acme has no user 3");
  const answers = [];
  for (const id of [3, 999]) {
    const invite = await acme.post(`/api/users/${id}/invite`, { tenant_id: 1 });
    const remove = await acme.del(`/api/users/${id}`);
    assert.equal(invite.status, 404);
    assert.equal(remove.status, 404);
    answers.push(invite.text, remove.text);
  }
  assert.equal(new Set(answers).size, 1);
  assert.deepEqual(demoState().users, DEMO.users);
});

test("users: resetting acme's staff (same email as demo's staff) leaves demo's staff account and login intact", async () => {
  const acmeStaffId = server.query("DB_T2", `SELECT id FROM users WHERE email = '${USERS.staff.email}'`)[0].id;
  const demoStaffId = DEMO.users.find((u) => u.email === USERS.staff.email).id;
  assert.equal(acmeStaffId, demoStaffId, "same id and same email at both vendors");
  const staffAtDemo = server.client("demo.localhost");
  await staffAtDemo.login(USERS.staff);
  const r = await acme.post(`/api/users/${acmeStaffId}/invite`, {});
  assert.equal(r.status, 200);
  assert.equal((await staffAtDemo.get("/api/auth/me")).status, 200, "demo's staff is still logged in at demo");
  const now = demoState();
  assert.deepEqual(now.users, DEMO.users, "demo's staff password and authenticator are untouched");
  await server.client("demo.localhost").login(USERS.staff);
  assert.equal((await server.client("acme.localhost").post("/api/auth/login", { email: USERS.staff.email, password: ACME_STAFF.password })).status, 400,
    "acme's staff was reset: their old password no longer works at acme");
});

test("users: adding an email that exists at demo creates a separate acme account", async () => {
  const r = await acme.post("/api/users", { email: USERS.admin.email, is_admin: true });
  assert.equal(r.status, 200);
  assert.match(r.json.invite, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.deepEqual(demoState().users, DEMO.users);
  await server.client("demo.localhost").login(USERS.admin);
});
