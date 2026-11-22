// create-tenant (new, --resume, --abandon), add-admin --tenant, create-platform-admin, and the local/remote guard.
// Local runs use throwaway folders (VENSTOCK_PERSIST_TO / VENSTOCK_GENERATED_DIR). The remote path runs against a copy
// of the repo with a fake `npx` that only records what it was asked to do: nothing ever reaches Cloudflare.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { localSql } from "./local-sql.mjs";
import { sha256, normalizeInvite } from "../src/lib/auth.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LATEST_VENDOR = Object.keys(JSON.parse(readFileSync(join(ROOT, "migrations", "vendor", "checksums.json"), "utf8"))).sort().at(-1);
let dir, env;

function script(name, args) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", name), ...args], { cwd: ROOT, encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
// Every call returns rows; UPDATE/INSERT simply return none.
const sql = (binding, command) => /^\s*select/i.test(command) ? localSql(env.VENSTOCK_PERSIST_TO)(binding, command) : localSql(env.VENSTOCK_PERSIST_TO)(binding, command, false) ?? [];
const tenant = (slug) => sql("CONTROL", `SELECT id, slug, name, status, db_binding, db_name, db_id, schema_version FROM tenants WHERE slug = '${slug}'`)[0];
const inviteFrom = (out) => out.match(/#invite=([A-Z0-9-]+)&email=/)?.[1];
const config = () => readFileSync(join(env.VENSTOCK_GENERATED_DIR, "wrangler.toml"), "utf8");

before(() => {
  dir = mkdtempSync(join(tmpdir(), "venstock-scripts-"));
  env = { ...process.env, VENSTOCK_PERSIST_TO: join(dir, "state"), VENSTOCK_GENERATED_DIR: join(dir, "gen") };
  const m = script("migrate.mjs", ["--control"]);
  assert.equal(m.code, 0, m.out);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("create-tenant: registry row, its own migrated database, identity row, owner invite, active", async () => {
  const r = script("create-tenant.mjs", ["demo", "Demo Shop", "owner@demo.test"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /About to touch LOCAL D1 databases/);
  for (let n = 1; n <= 5; n++) assert.match(r.out, new RegExp(`\\[${n}/5\\]`));
  assert.match(r.out, /http:\/\/demo\.localhost:8788\/#invite=[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}&email=owner%40demo\.test/);
  assert.deepEqual(tenant("demo"), { id: 1, slug: "demo", name: "Demo Shop", status: "active", db_binding: "DB_T1",
    db_name: "venstock-local-t1", db_id: "local-t1", schema_version: LATEST_VENDOR });
  assert.deepEqual(sql("DB_T1", "SELECT tenant_id, slug FROM vendor_identity"), [{ tenant_id: 1, slug: "demo" }]);
  const [u] = sql("DB_T1", "SELECT email, is_admin, password_hash, invite_hash FROM users");
  assert.equal(u.email, "owner@demo.test");
  assert.equal(u.is_admin, 1);
  assert.equal(u.password_hash, null);
  assert.equal(u.invite_hash, await sha256(normalizeInvite(inviteFrom(r.out))));
  assert.match(config(), /binding = "DB_T1"/);
  assert.equal(sql("CONTROL", "SELECT count(*) AS n FROM sqlite_master WHERE name = 'users'")[0].n, 0, "vendor users never go into control");
});

test("a second vendor gets its own database; each owner exists only in their own", () => {
  const r = script("create-tenant.mjs", ["acme", "Acme Crafts", "owner@acme.test"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(tenant("acme").db_binding, "DB_T2");
  assert.deepEqual(sql("DB_T1", "SELECT email FROM users"), [{ email: "owner@demo.test" }]);
  assert.deepEqual(sql("DB_T2", "SELECT email FROM users"), [{ email: "owner@acme.test" }]);
  assert.deepEqual(sql("DB_T2", "SELECT tenant_id, slug FROM vendor_identity"), [{ tenant_id: 2, slug: "acme" }]);
  const r2 = script("create-tenant.mjs", ["acme-two", "Acme Two", "owner@demo.test"]);
  assert.equal(r2.code, 0, "the same email can own two vendors: each database has its own users");
});

test("create-tenant refuses bad, reserved and taken slugs, bad names and emails, and writes nothing", () => {
  const before = sql("CONTROL", "SELECT count(*) AS n FROM tenants")[0].n;
  for (const slug of ["Acme", "ab", "-acme", "acme-", "ac_me", "a.b", "x".repeat(33), "admin", "www", "staging", "acme",
    "xn--dmo-xla", "xn--80ak6aa92e", "ab--cd", "ab--", "démo", "shop!", "shop shop"]) {
    assert.notEqual(script("create-tenant.mjs", [slug, "Some Shop", "x@example.test"]).code, 0, `slug ${slug}`);
  }
  const xn = script("create-tenant.mjs", ["xn--dmo-xla", "Look-alike", "x@example.test"]);
  assert.match(xn.out, /not "--" as the 3rd and 4th characters/);
  assert.notEqual(script("create-tenant.mjs", ["fine-slug", "   ", "a@example.test"]).code, 0, "blank name");
  assert.notEqual(script("create-tenant.mjs", ["fine-slug", "Bad\u0007Name", "a@example.test"]).code, 0, "control char");
  assert.notEqual(script("create-tenant.mjs", ["fine-slug", "Fine", "not-an-email"]).code, 0, "bad email");
  assert.notEqual(script("create-tenant.mjs", ["fine-slug", "Fine"]).code, 0, "missing email");
  assert.equal(sql("CONTROL", "SELECT count(*) AS n FROM tenants")[0].n, before);
});

test("values are escaped: quotes and SQL in the vendor name are stored literally", () => {
  const evil = "Bob's Shop'); DROP TABLE tenants; --";
  const r = script("create-tenant.mjs", ["bobs-shop", evil, "bob@example.test"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(tenant("bobs-shop").name, evil);
});

test("--resume finishes a vendor that stopped before its database was recorded", () => {
  sql("CONTROL", `INSERT INTO tenants (slug, name, status, db_binding, db_name, owner_email, created_at, status_changed_at)
    VALUES ('halfway', 'Halfway', 'provisioning', 'pending', 'pending', 'owner@halfway.test', 'x', 'x')`);
  const r = script("create-tenant.mjs", ["--resume", "halfway"]);
  assert.equal(r.code, 0, r.out);
  const row = tenant("halfway");
  assert.equal(row.status, "active");
  assert.equal(row.db_binding, `DB_T${row.id}`, "the 'pending' binding is fixed to the derived name");
  assert.equal(row.schema_version, LATEST_VENDOR);
  assert.match(r.out, /#invite=/);
});

test("--resume after the database exists but before the owner: completes, and a second resume is refused", () => {
  sql("CONTROL", `INSERT INTO tenants (slug, name, status, db_binding, db_name, db_id, owner_email, created_at, status_changed_at)
    VALUES ('migrated', 'Migrated', 'provisioning', 'pending', 'pending', NULL, 'o@m.test', 'x', 'x')`);
  const id = tenant("migrated").id;
  sql("CONTROL", `UPDATE tenants SET db_binding = 'DB_T${id}', db_name = 'venstock-local-t${id}', db_id = 'local-t${id}' WHERE id = ${id}`);
  assert.equal(script("migrate.mjs", ["--tenant", "migrated"]).code, 0);
  const r = script("create-tenant.mjs", ["--resume", "migrated"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already recorded/);
  assert.equal(tenant("migrated").status, "active");
  const again = script("create-tenant.mjs", ["--resume", "migrated"]);
  assert.notEqual(again.code, 0);
  assert.match(again.out, /already active/);
});

test("create-tenant stops when the recorded database belongs to another vendor, and changes nothing in it", () => {
  const demoUsers = sql("DB_T1", "SELECT email FROM users ORDER BY email");
  sql("CONTROL", `INSERT INTO tenants (slug, name, status, db_binding, db_name, db_id, owner_email, created_at, status_changed_at)
    VALUES ('miswired', 'Miswired', 'provisioning', 'pending', 'pending', NULL, 'o@miswired.test', 'x', 'x')`);
  const id = tenant("miswired").id;
  // Its db_id is demo's database (as if a database id had been copied into the wrong row).
  sql("CONTROL", `UPDATE tenants SET db_binding = 'DB_T${id}', db_name = 'venstock-local-t${id}', db_id = 'local-t1' WHERE id = ${id}`);
  const r = script("create-tenant.mjs", ["--resume", "miswired"]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /STOP: .* says it belongs to .*"slug":"demo"/);
  assert.equal(tenant("miswired").status, "provisioning");
  assert.deepEqual(sql("DB_T1", "SELECT tenant_id, slug FROM vendor_identity"), [{ tenant_id: 1, slug: "demo" }]);
  assert.deepEqual(sql("DB_T1", "SELECT email FROM users ORDER BY email"), demoUsers, "no owner was added to demo's database");
  assert.equal(script("create-tenant.mjs", ["--abandon", "miswired"]).code, 0);
});

test("--abandon: marks a provisioning vendor deleted, drops its binding, names the database; refuses live vendors", () => {
  sql("CONTROL", `INSERT INTO tenants (slug, name, status, db_binding, db_name, db_id, owner_email, created_at, status_changed_at)
    VALUES ('stuck', 'Stuck', 'provisioning', 'pending', 'pending', NULL, 's@s.test', 'x', 'x')`);
  const id = tenant("stuck").id;
  sql("CONTROL", `UPDATE tenants SET db_binding = 'DB_T${id}', db_name = 'venstock-local-t${id}', db_id = 'local-t${id}' WHERE id = ${id}`);
  script("build-config.mjs", []);
  assert.match(config(), new RegExp(`binding = "DB_T${id}"`));
  const r = script("create-tenant.mjs", ["--abandon", "stuck"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`venstock-local-t${id}`));
  assert.doesNotMatch(r.out, /wrangler d1 delete/, "local: no remote delete command offered");
  assert.equal(tenant("stuck").status, "deleted");
  assert.doesNotMatch(config(), new RegExp(`binding = "DB_T${id}"`), "the binding is gone from the generated config");
  assert.notEqual(script("create-tenant.mjs", ["stuck", "Stuck Again", "s@s.test"]).code, 0, "an abandoned slug can't be reused");
  assert.notEqual(script("create-tenant.mjs", ["--resume", "stuck"]).code, 0);

  const live = script("create-tenant.mjs", ["--abandon", "demo"]);
  assert.notEqual(live.code, 0);
  assert.match(live.out, /is active, not provisioning/);
  assert.equal(tenant("demo").status, "active");
  assert.notEqual(script("create-tenant.mjs", ["--abandon", "nosuch"]).code, 0);
});

test("add-admin works in the named vendor's database only", () => {
  const r = script("add-admin.mjs", ["--tenant", "acme", "second@acme.test"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /http:\/\/acme\.localhost:8788\/#invite=/);
  assert.deepEqual(sql("DB_T2", "SELECT email FROM users ORDER BY id").map((u) => u.email), ["owner@acme.test", "second@acme.test"]);
  assert.deepEqual(sql("DB_T1", "SELECT email FROM users").map((u) => u.email), ["owner@demo.test"]);
});

test("add-admin resets a locked-out admin and ends only that user's sessions", () => {
  sql("DB_T2", `UPDATE users SET password_hash = 'x' WHERE email = 'owner@acme.test';
    INSERT INTO sessions (id, user_id, mfa_ok, expires_at, created_at) SELECT 'owner-s', id, 1, 9999999999999, 'x' FROM users WHERE email = 'owner@acme.test';
    INSERT INTO sessions (id, user_id, mfa_ok, expires_at, created_at) SELECT 'second-s', id, 1, 9999999999999, 'x' FROM users WHERE email = 'second@acme.test'`);
  const r = script("add-admin.mjs", ["--tenant", "acme", "owner@acme.test"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /reset/);
  assert.deepEqual(sql("DB_T2", "SELECT password_hash FROM users WHERE email = 'owner@acme.test'"), [{ password_hash: null }]);
  assert.deepEqual(sql("DB_T2", "SELECT id FROM sessions"), [{ id: "second-s" }]);
});

test("add-admin refusals: no --tenant, unknown or abandoned vendor, a database that doesn't identify as the vendor", () => {
  assert.notEqual(script("add-admin.mjs", ["x@example.test"]).code, 0);
  assert.notEqual(script("add-admin.mjs", ["--tenant"]).code, 0);
  assert.match(script("add-admin.mjs", ["--tenant", "nosuch", "x@example.test"]).out, /No vendor/);
  assert.match(script("add-admin.mjs", ["--tenant", "stuck", "x@example.test"]).out, /No vendor/);
  sql("DB_T2", "UPDATE vendor_identity SET slug = 'someone-else'");
  try {
    const r = script("add-admin.mjs", ["--tenant", "acme", "x@example.test"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /doesn't identify as acme/);
    assert.equal(sql("DB_T2", "SELECT count(*) AS n FROM users WHERE email = 'x@example.test'")[0].n, 0);
  } finally { sql("DB_T2", "UPDATE vendor_identity SET slug = 'acme'"); }
});

test("create-platform-admin writes the control database, never a vendor database", () => {
  const r = script("create-platform-admin.mjs", ["staff@venstock.test"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /http:\/\/admin\.localhost:8788\/#invite=/);
  assert.deepEqual(sql("CONTROL", "SELECT email, password_hash FROM platform_admins"), [{ email: "staff@venstock.test", password_hash: null }]);
  for (const b of ["DB_T1", "DB_T2"]) assert.equal(sql(b, "SELECT count(*) AS n FROM users WHERE email = 'staff@venstock.test'")[0].n, 0);
  assert.equal(script("create-platform-admin.mjs", ["staff@venstock.test"]).code, 0, "running again resets it");
  assert.equal(sql("CONTROL", "SELECT count(*) AS n FROM platform_admins")[0].n, 1);
});

test("create-platform-admin --disable: no login, sessions gone, open support sessions ended, audited; running again re-enables", () => {
  assert.equal(script("create-platform-admin.mjs", ["--disable", "nobody@venstock.test"]).code !== 0, true, "an unknown admin is refused");
  const [{ id }] = sql("CONTROL", "SELECT id FROM platform_admins WHERE email = 'staff@venstock.test'");
  const [{ id: tenantId }] = sql("CONTROL", "SELECT id FROM tenants ORDER BY id LIMIT 1");
  sql("CONTROL", `INSERT INTO platform_sessions (id, admin_id, mfa_ok, expires_at, created_at) VALUES ('s-disable', ${id}, 1, ${Date.now() + 3600000}, 'x')`);
  sql("CONTROL", `INSERT INTO support_sessions (admin_id, tenant_id, reason, code_hash, created_at, expires_at)
    VALUES (${id}, ${tenantId}, 'open when disabled', 'h-disable', 'x', ${Date.now() + 600000})`);
  const r = script("create-platform-admin.mjs", ["--disable", "staff@venstock.test"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /is disabled/);
  const [row] = sql("CONTROL", `SELECT disabled_at, password_hash, invite_hash FROM platform_admins WHERE id = ${id}`);
  assert.ok(row.disabled_at);
  assert.equal(row.invite_hash, null);
  assert.equal(sql("CONTROL", `SELECT count(*) AS n FROM platform_sessions WHERE admin_id = ${id}`)[0].n, 0);
  assert.deepEqual(sql("CONTROL", "SELECT code_hash, ended_by FROM support_sessions WHERE reason = 'open when disabled'"),
    [{ code_hash: null, ended_by: "admin-disabled" }]);
  assert.equal(sql("CONTROL", `SELECT count(*) AS n FROM audit_log WHERE action = 'platform.admin.disabled' AND admin_id = ${id}`)[0].n, 1);
  assert.equal(script("create-platform-admin.mjs", ["staff@venstock.test"]).code, 0);
  assert.equal(sql("CONTROL", `SELECT disabled_at FROM platform_admins WHERE id = ${id}`)[0].disabled_at, null, "re-enabled with a new invite");
});

test("scripts that stop early or only touch control never strip vendors from the shared config", () => {
  script("build-config.mjs", []);
  const before = config();
  assert.match(before, /binding = "DB_T1"/);
  assert.notEqual(script("add-admin.mjs", ["--tenant", "nosuch", "x@example.test"]).code, 0);
  assert.equal(config(), before, "a refused add-admin left the config alone");
  assert.equal(script("create-platform-admin.mjs", ["other@venstock.test"]).code, 0);
  assert.equal(config(), before, "create-platform-admin never rewrites it");
  assert.notEqual(script("create-tenant.mjs", ["Bad Slug", "x", "x@example.test"]).code, 0);
  assert.equal(config(), before, "a refused create-tenant left the config alone");
});
