// Unit tests (no server) for the registry cache (src/lib/control.js) and the resolver (src/lib/tenant.js), with a
// fake clock and fake D1 objects. The real-server version of these rules is tests/tenancy.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, REGISTRY_TTL_MS } from "../src/lib/control.js";
import { resolveVendor, vendorBinding } from "../src/lib/tenant.js";

// A fake D1: rows(sql, args) answers each query; every query is recorded.
function fakeD1(rows) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      let args = [];
      return {
        bind(...a) { args = a; return this; },
        async first() { calls.push({ sql, args }); return rows(sql, args)[0] ?? null; },
        async all() { calls.push({ sql, args }); return { results: rows(sql, args) }; },
      };
    },
  };
}
const clock = (t = 1_000_000) => { const c = () => t; c.advance = (ms) => { t += ms; }; return c; };

function setup(tenants, vendorDbs = {}) {
  const control = fakeD1((sql, [slug]) => tenants.filter((t) => t.slug === slug));
  const env = { BASE_DOMAIN: "localhost", CONTROL: control, ...vendorDbs };
  const now = clock();
  const registry = createRegistry({ now });
  return { env, control, now, registry, resolve: (host, verified = new Set()) => resolveVendor(env, host, { registry, verified }) };
}
const identityDb = (tenant_id, slug) => fakeD1(() => [{ tenant_id, slug }]);
const row = (id, slug, status = "active", db_binding = vendorBinding(id)) => ({ id, slug, name: slug, status, db_binding });

test("registry cache: TTL is between 30 and 60 seconds", () => {
  assert.ok(REGISTRY_TTL_MS >= 30_000 && REGISTRY_TTL_MS <= 60_000, String(REGISTRY_TTL_MS));
});

test("registry cache: a hit doesn't query control; expiry does", async () => {
  const { env, control, now, registry } = setup([row(1, "demo")]);
  assert.equal((await registry.lookup(env, "demo")).id, 1);
  assert.equal((await registry.lookup(env, "demo")).id, 1);
  assert.equal(control.calls.length, 1, "second lookup is a cache hit");
  now.advance(REGISTRY_TTL_MS - 1);
  await registry.lookup(env, "demo");
  assert.equal(control.calls.length, 1, "still cached just before expiry");
  now.advance(1);
  await registry.lookup(env, "demo");
  assert.equal(control.calls.length, 2, "expired: queried again");
  assert.deepEqual(control.calls[0].args, ["demo"], "the slug is a bound parameter");
});

test("registry cache: unknown vendors are cached too, and a new vendor appears after expiry", async () => {
  const tenants = [];
  const { env, control, now, registry } = setup(tenants);
  assert.equal(await registry.lookup(env, "newshop"), null);
  for (let i = 0; i < 5; i++) assert.equal(await registry.lookup(env, "newshop"), null);
  assert.equal(control.calls.length, 1, "a flood of requests for an unknown slug hits control once");
  tenants.push(row(7, "newshop"));
  assert.equal(await registry.lookup(env, "newshop"), null, "created, but the cached miss stands until expiry");
  now.advance(REGISTRY_TTL_MS);
  assert.equal((await registry.lookup(env, "newshop")).id, 7);
});

test("registry cache: a status change is seen after expiry", async () => {
  const tenants = [row(1, "demo")];
  const { env, now, registry } = setup(tenants);
  assert.equal((await registry.lookup(env, "demo")).status, "active");
  tenants[0] = row(1, "demo", "suspended");
  assert.equal((await registry.lookup(env, "demo")).status, "active");
  now.advance(REGISTRY_TTL_MS);
  assert.equal((await registry.lookup(env, "demo")).status, "suspended");
});

test("registry cache: bounded size under a flood of made-up slugs", async () => {
  const env = { CONTROL: fakeD1(() => []) };
  const registry = createRegistry({ maxEntries: 3, now: clock() });
  for (const s of ["a1", "a2", "a3", "a4", "a5"]) await registry.lookup(env, s);
  assert.equal(registry.size, 3);
});

test("resolver: active vendor gets exactly its own binding", async () => {
  const DB_T1 = identityDb(1, "demo"), DB_T2 = identityDb(2, "acme");
  const { resolve } = setup([row(1, "demo"), row(2, "acme")], { DB_T1, DB_T2 });
  const a = await resolve("demo.localhost");
  assert.equal(a.kind, "active");
  assert.equal(a.db, DB_T1);
  assert.deepEqual(a.tenant, { id: 1, slug: "demo", name: "demo", status: "active" });
  assert.equal((await resolve("ACME.localhost")).db, DB_T2);
});

test("resolver: unknown, reserved, deleted and malformed hosts are notFound, without touching vendor databases", async () => {
  const DB_T1 = identityDb(1, "demo");
  const { resolve, control } = setup([row(1, "demo"), row(2, "gone", "deleted"), row(3, "www")], { DB_T1 });
  for (const h of ["nosuch.localhost", "www.localhost", "gone.localhost", "localhost", "x.demo.localhost", "demo.example.com", "127.0.0.1"]) {
    assert.deepEqual(await resolve(h), { kind: "notFound" }, h);
  }
  assert.equal(DB_T1.calls.length, 0);
  assert.ok(control.calls.every((c) => ["nosuch", "gone"].includes(c.args[0])), "reserved and malformed hosts never reach control");
});

test("resolver: no BASE_DOMAIN means nothing resolves", async () => {
  const { env, resolve } = setup([row(1, "demo")], { DB_T1: identityDb(1, "demo") });
  delete env.BASE_DOMAIN;
  assert.deepEqual(await resolve("demo.localhost"), { kind: "notFound" });
});

test("resolver: a tampered db_binding is refused even when that binding exists", async () => {
  const DB_T1 = identityDb(1, "demo"), DB_T2 = identityDb(2, "acme");
  const { resolve } = setup([row(1, "demo"), row(2, "acme", "active", "DB_T1")], { DB_T1, DB_T2 });
  const r = await resolve("acme.localhost");
  assert.equal(r.kind, "refused");
  assert.match(r.reason, /db_binding DB_T1, expected DB_T2/);
  assert.equal(r.db, undefined);
  assert.equal(DB_T1.calls.length + DB_T2.calls.length, 0, "no vendor database is touched");
});

test("resolver: a binding wired to another vendor's database fails the identity check", async () => {
  const demoDb = identityDb(1, "demo");
  const { resolve } = setup([row(1, "demo"), row(2, "acme")], { DB_T1: demoDb, DB_T2: demoDb });
  const r = await resolve("acme.localhost");
  assert.equal(r.kind, "refused");
  assert.match(r.reason, /DB_T2 identifies as .*"slug":"demo"/);
  assert.equal(r.db, undefined);
});

test("resolver: the identity must match on both id and slug", async () => {
  const { resolve } = setup([row(1, "demo"), row(2, "acme")], { DB_T1: identityDb(1, "other"), DB_T2: identityDb(9, "acme") });
  assert.equal((await resolve("demo.localhost")).kind, "refused", "right id, wrong slug");
  assert.equal((await resolve("acme.localhost")).kind, "refused", "right slug, wrong id");
});

test("resolver: a database without a readable identity, or with several rows, is refused", async () => {
  const broken = { prepare: () => ({ all: async () => { throw new Error("no such table: vendor_identity"); } }) };
  const two = fakeD1(() => [{ tenant_id: 2, slug: "acme" }, { tenant_id: 2, slug: "acme" }]);
  const { resolve } = setup([row(1, "demo"), row(2, "acme")], { DB_T1: broken, DB_T2: two });
  assert.equal((await resolve("demo.localhost")).kind, "refused");
  assert.equal((await resolve("acme.localhost")).kind, "refused");
});

test("resolver: the identity check runs once per isolate, and only a pass is remembered", async () => {
  const DB_T1 = identityDb(1, "demo");
  const verified = new Set();
  const { resolve } = setup([row(1, "demo")], { DB_T1 });
  await resolve("demo.localhost", verified);
  await resolve("demo.localhost", verified);
  assert.equal(DB_T1.calls.length, 1);

  const wrong = identityDb(9, "other");
  const s2 = setup([row(1, "demo")], { DB_T1: wrong });
  const v2 = new Set();
  assert.equal((await s2.resolve("demo.localhost", v2)).kind, "refused");
  assert.equal((await s2.resolve("demo.localhost", v2)).kind, "refused");
  assert.equal(wrong.calls.length, 2, "a failure is checked again, never cached as a pass");
});

test("resolver: provisioning or an unbound database is settingUp; suspended never touches the database", async () => {
  const DB_T3 = identityDb(3, "closed");
  const { resolve } = setup([row(1, "fresh", "provisioning"), row(2, "unbound"), row(3, "closed", "suspended")], { DB_T3 });
  assert.equal((await resolve("fresh.localhost")).kind, "settingUp");
  assert.equal((await resolve("unbound.localhost")).kind, "settingUp");
  const s = await resolve("closed.localhost");
  assert.equal(s.kind, "suspended");
  assert.equal(s.db, undefined);
  assert.equal(DB_T3.calls.length, 0);
});

test("resolver: an unbound vendor never falls back to CONTROL or another binding", async () => {
  const DB_T1 = identityDb(1, "demo");
  const { resolve, env } = setup([row(1, "demo"), row(2, "acme")], { DB_T1 });
  env.DB = DB_T1; // even a leftover generic binding is never used
  const r = await resolve("acme.localhost");
  assert.equal(r.kind, "settingUp");
  assert.equal(r.db, undefined);
});

test("resolver: hostnames that can't be a vendor slug never query the control database", async () => {
  const { resolve, control } = setup([row(1, "demo")], { DB_T1: identityDb(1, "demo") });
  for (const h of ["ab.localhost", "xn--dmo-xla.localhost", "ab--cd.localhost", `${"x".repeat(33)}.localhost`, "-abc.localhost",
    "a_b.localhost", "x.demo.localhost", "localhost", "", "demo.localhost.evil.com"]) {
    assert.deepEqual(await resolve(h), { kind: "notFound" }, h);
  }
  assert.deepEqual(control.calls, []);
});

test("resolver: admin.<BASE_DOMAIN> is the platform host and gets the control database, never a vendor's", async () => {
  const DB_T1 = identityDb(1, "demo");
  const { resolve, env, control } = setup([row(1, "demo"), row(2, "admin")], { DB_T1 });
  const r = await resolve("admin.localhost");
  assert.equal(r.kind, "platform");
  assert.equal(r.db, env.CONTROL);
  assert.equal(r.tenant, undefined);
  assert.deepEqual(control.calls, [], "no registry lookup: even a registry row named admin is never a vendor");
  assert.equal(DB_T1.calls.length, 0);
  assert.equal((await resolve("ADMIN.localhost.")).kind, "platform");
  assert.deepEqual(await resolve("admin.demo.localhost"), { kind: "notFound" });
});
