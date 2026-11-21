// Vendor resolution against a real local server: which hosts serve a vendor, which get 404, what a suspended or
// half-set-up vendor sees, and that a miswired binding never serves another vendor's data.
// The same rules with fakes (and the cache's clock) are in tests/resolver.unit.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, rawRequest, USERS } from "./harness.mjs";

const marker = (name) => `INSERT INTO items (name, price_cents, stock) VALUES ('${name}', 100, 1);`;
let server;
before(async () => {
  server = await startServer({ vendors: [
    { slug: "demo", users: [USERS.admin], seedSql: marker("demo-marker") },     // 1
    { slug: "acme", users: [USERS.staff], seedSql: marker("acme-marker") },     // 2
    { slug: "closed", status: "suspended" },                                    // 3
    { slug: "fresh", status: "provisioning" },                                  // 4
    { slug: "unbound", bind: false },                                           // 5: registered, but no binding in this deploy
    { slug: "crossed", databaseOf: "demo", users: [] },                         // 6: DB_T6 points at demo's database
    { slug: "tampered", registryBinding: "DB_T1", users: [] },                  // 7: registry says DB_T1 (demo's)
    { slug: "gone", status: "deleted" },                                        // 8
    { slug: "www" },                                                            // 9: a registry row with a reserved slug
  ] });
});
after(async () => { await server?.stop(); });

const get = (host, path, extra = {}) => rawRequest(server.port, { host, path, ...extra });
const loginAt = (host, user = USERS.admin) => get(host, "/api/auth/login", { method: "POST", body: { email: user.email, password: user.password } });
const SHELL = ["/", "/app.js", "/sw.js"];
const API = ["/api", "/api/auth/me", "/api/items"];

for (const [label, host] of [
  ["unknown vendor", "nosuch.localhost"],
  ["reserved slug (admin)", "admin.localhost"],
  ["reserved slug with a registry row (www)", "www.localhost"],
  ["deleted vendor", "gone.localhost"],
  ["two levels deep", "x.demo.localhost"],
  ["bare BASE_DOMAIN", "localhost"],
  ["another domain", "demo.example.com"],
  ["raw IP", "127.0.0.1"],
]) {
  test(`${label} (${host}): 404 for the app shell and the API`, async () => {
    for (const p of SHELL) assert.equal((await get(host, p)).status, 404, `${host}${p}`);
    for (const p of API) {
      const r = await get(host, p);
      assert.equal(r.status, 404, `${host}${p}`);
      assert.deepEqual(r.json, { error: "Not found" });
    }
    assert.equal((await loginAt(host)).status, 404);
  });
}

test("unknown, reserved and deleted hosts give identical responses (nothing reveals which slugs exist)", async () => {
  for (const p of ["/", "/api/auth/me"]) {
    const [a, ...others] = await Promise.all(["nosuch", "www", "admin", "gone"].map((s) => get(`${s}.localhost`, p)));
    for (const o of others) {
      assert.equal(o.text, a.text);
      assert.equal(o.headers["content-type"], a.headers["content-type"]);
    }
  }
});

test("active vendors: shell served, API answers, each sees only its own database", async () => {
  for (const host of ["demo.localhost", "acme.localhost", "DEMO.localhost"]) {
    assert.equal((await get(host, "/")).status, 200, host);
    assert.equal((await get(host, "/api/auth/me")).status, 401, host);
  }
  const demo = server.client("demo.localhost");
  await demo.login(USERS.admin);
  assert.deepEqual((await demo.get("/api/items")).json.map((i) => i.name), ["demo-marker"]);
  // The vendor comes only from the hostname: query strings and headers naming another vendor change nothing.
  assert.deepEqual((await demo.get("/api/items?tenant=acme&tenant_id=2&slug=acme")).json.map((i) => i.name), ["demo-marker"]);
  assert.deepEqual((await demo.req("GET", "/api/items", undefined, { "x-tenant": "acme", "x-forwarded-host": "acme.localhost" })).json.map((i) => i.name), ["demo-marker"]);

  const acme = server.client("acme.localhost");
  await acme.login(USERS.staff);
  assert.deepEqual((await acme.get("/api/items")).json.map((i) => i.name), ["acme-marker"]);
  assert.equal((await loginAt("acme.localhost", USERS.admin)).status, 400, "demo's admin doesn't exist at acme");
});

test("suspended vendor: app shell is served, every API call gets 403", async () => {
  for (const p of SHELL) assert.equal((await get("closed.localhost", p)).status, 200, p);
  assert.match((await get("closed.localhost", "/")).text, /<title>Venstock<\/title>/);
  for (const p of API) {
    const r = await get("closed.localhost", p);
    assert.equal(r.status, 403, p);
    assert.match(r.json.error, /suspended/i);
  }
  assert.equal((await loginAt("closed.localhost")).status, 403);
});

for (const [label, host] of [["provisioning vendor", "fresh.localhost"], ["vendor whose binding isn't deployed", "unbound.localhost"]]) {
  test(`${label} (${host}): 503 "being set up" on every path, never cached`, async () => {
    for (const p of SHELL) {
      const r = await get(host, p);
      assert.equal(r.status, 503, p);
      assert.match(r.text, /being set up/);
      assert.match(r.headers["content-type"], /text\/html/);
      assert.equal(r.headers["cache-control"], "no-store");
    }
    for (const p of API) {
      const r = await get(host, p);
      assert.equal(r.status, 503, p);
      assert.match(r.json.error, /being set up/);
      assert.equal(r.headers["cache-control"], "no-store");
    }
    assert.equal((await loginAt(host)).status, 503);
  });
}

for (const [label, host, reason] of [
  ["binding wired to another vendor's database", "crossed.localhost", /DB_T6 identifies as .*demo/],
  ["tampered registry binding", "tampered.localhost", /db_binding DB_T1, expected DB_T7/],
]) {
  test(`${label} (${host}): refused on every path, demo's data never served, reason only in the log`, async () => {
    for (const p of [...SHELL, ...API]) {
      const r = await get(host, p);
      assert.equal(r.status, 500, p);
      assert.doesNotMatch(r.text, /demo|DB_T|identif/i, "the response doesn't explain the wiring");
    }
    // demo's admin and password, at the miswired host: never a login into demo's database.
    const login = await loginAt(host);
    assert.equal(login.status, 500);
    assert.equal(login.headers["set-cookie"], undefined);
    assert.match(server.log(), reason);
  });
}

test("registry lookups are cached in the isolate (a suspension isn't instant; see CLAUDE.md)", async () => {
  assert.equal((await get("acme.localhost", "/api/auth/me")).status, 401);
  server.query("CONTROL", "UPDATE tenants SET status = 'suspended' WHERE slug = 'acme'");
  try {
    assert.equal((await get("acme.localhost", "/api/auth/me")).status, 401, "still the cached row, within the 45 s window");
  } finally {
    server.query("CONTROL", "UPDATE tenants SET status = 'active' WHERE slug = 'acme'");
  }
});
