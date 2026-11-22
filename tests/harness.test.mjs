// The multi-database harness itself: a control registry, one database per vendor, and the deliberate miswirings
// the resolver tests rely on. If these are wrong, the isolation tests built on them prove nothing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, USERS } from "./harness.mjs";

let server;
const binding = (toml, name) => toml.split("[[d1_databases]]").find((b) => b.includes(`binding = "${name}"`));

before(async () => {
  server = await startServer({ vendors: [
    { slug: "demo", name: "Demo Shop", users: [USERS.admin], seedSql: "INSERT INTO items (name, price_cents, stock) VALUES ('demo-marker', 100, 1);" },
    { slug: "acme", users: [USERS.staff], seedSql: "INSERT INTO items (name, price_cents, stock) VALUES ('acme-marker', 200, 2);" },
    { slug: "unbound", bind: false },
    { slug: "crossed", databaseOf: "demo" },
    { slug: "tampered", registryBinding: "DB_T1", status: "suspended" },
  ] });
});
after(async () => { await server?.stop(); });

test("the registry lists every vendor with its derived binding (or the tampered one)", () => {
  const rows = server.query("CONTROL", "SELECT id, slug, name, status, db_binding, db_id FROM tenants ORDER BY id");
  assert.deepEqual(rows, [
    { id: 1, slug: "demo", name: "Demo Shop", status: "active", db_binding: "DB_T1", db_id: "local-t1" },
    { id: 2, slug: "acme", name: "acme", status: "active", db_binding: "DB_T2", db_id: "local-t2" },
    { id: 3, slug: "unbound", name: "unbound", status: "active", db_binding: "DB_T3", db_id: "local-t3" },
    { id: 4, slug: "crossed", name: "crossed", status: "active", db_binding: "DB_T4", db_id: "local-t4" },
    { id: 5, slug: "tampered", name: "tampered", status: "suspended", db_binding: "DB_T1", db_id: "local-t5" },
  ]);
  assert.deepEqual(server.vendors.map((v) => v.host), ["demo.localhost", "acme.localhost", "unbound.localhost", "crossed.localhost", "tampered.localhost"]);
});

test("each vendor database holds only its own identity, users and data", () => {
  for (const v of server.vendors) {
    assert.deepEqual(server.query(v.binding, "SELECT tenant_id, slug FROM vendor_identity"), [{ tenant_id: v.id, slug: v.slug }]);
  }
  assert.deepEqual(server.query("DB_T1", "SELECT email FROM users"), [{ email: USERS.admin.email }]);
  assert.deepEqual(server.query("DB_T2", "SELECT email FROM users"), [{ email: USERS.staff.email }]);
  assert.deepEqual(server.query("DB_T1", "SELECT name FROM items"), [{ name: "demo-marker" }]);
  assert.deepEqual(server.query("DB_T2", "SELECT name FROM items"), [{ name: "acme-marker" }]);
  assert.equal(server.query("CONTROL", "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('users', 'items')")[0].n, 0);
});

test("the server config wires each binding as asked, including the deliberate miswirings", () => {
  const toml = server.configText();
  assert.match(binding(toml, "CONTROL"), /database_id = "local-control"/);
  assert.match(binding(toml, "DB_T1"), /database_id = "local-t1"/);
  assert.match(binding(toml, "DB_T2"), /database_id = "local-t2"/);
  assert.equal(binding(toml, "DB_T3"), undefined, "bind: false leaves the binding out");
  assert.match(binding(toml, "DB_T4"), /database_id = "local-t1"/, "databaseOf points DB_T4 at demo's database");
  assert.match(binding(toml, "DB_T5"), /database_id = "local-t5"/);
});

test("the app answers at demo.localhost", async () => {
  const c = server.client();
  assert.equal(c.host, "demo.localhost");
  assert.equal((await c.get("/")).status, 200);
  await c.login(USERS.admin);
  assert.equal((await c.get("/api/auth/me")).status, 200);
});
