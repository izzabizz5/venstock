// suspend-tenant and delete-tenant end to end, locally: the scripts change a real local control database, and a real
// local server (wrangler dev) then answers accordingly. Each vendor's host is requested for the first time only after
// the scripts ran, so the Worker's 45-second registry cache never holds an older answer.
// The rules themselves (with no database) are in tests/tenant-status.unit.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, rawRequest, USERS, PLATFORM_ADMIN } from "./harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const marker = (name) => `INSERT INTO items (name, price_cents, stock) VALUES ('${name}', 100, 1);`;
let server, gen;

before(async () => {
  server = await startServer({ platformAdmins: [PLATFORM_ADMIN], vendors: [
    { slug: "demo", seedSql: marker("demo-marker") },      // 1: never touched
    { slug: "acme", seedSql: marker("acme-marker") },      // 2: suspended
    { slug: "paused" },                                    // 3: suspended, then resumed
    { slug: "gone", seedSql: marker("gone-marker") },      // 4: suspended, then deleted
  ] });
  gen = mkdtempSync(join(tmpdir(), "venstock-lifecycle-gen-"));
  const now = new Date().toISOString();
  server.query("CONTROL", `INSERT INTO support_sessions (admin_id, tenant_id, reason, token_hash, created_at, expires_at, entered_at)
    VALUES (1, 2, 'open on acme', 'tok-acme', '${now}', ${Date.now() + 600_000}, '${now}'),
           (1, 1, 'open on demo', 'tok-demo', '${now}', ${Date.now() + 600_000}, '${now}')`);
});
after(async () => {
  await server?.stop();
  if (gen) rmSync(gen, { recursive: true, force: true });
});

function script(name, ...args) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", name), ...args], { cwd: ROOT, encoding: "utf8",
    env: { ...process.env, VENSTOCK_PERSIST_TO: server.persistTo, VENSTOCK_GENERATED_DIR: gen } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const get = (slug, path) => rawRequest(server.port, { host: `${slug}.localhost`, path });
const status = (slug) => server.query("CONTROL", `SELECT status FROM tenants WHERE slug = '${slug}'`)[0]?.status;
const audit = (tenantId) => server.query("CONTROL", `SELECT action, detail, admin_id FROM audit_log WHERE tenant_id = ${tenantId} ORDER BY id`);

test("suspend: the site still opens, every API call answers 403, open support sessions on that vendor end, audited", async () => {
  const r = script("suspend-tenant.mjs", "acme", "--reason", "Unpaid invoice");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /About to touch LOCAL D1 databases/);
  assert.match(r.out, /"acme" \(acme, tenant 2\) is suspended/);
  assert.equal(status("acme"), "suspended");
  assert.equal((await get("acme", "/")).status, 200);
  for (const path of ["/api/auth/me", "/api/items"]) {
    const res = await get("acme", path);
    assert.equal(res.status, 403, path);
    assert.match(res.json.error, /suspended/i);
  }
  assert.deepEqual(audit(2), [{ action: "vendor.suspended", detail: "by scripts/suspend-tenant.mjs; reason: Unpaid invoice", admin_id: null }]);
  const sessions = server.query("CONTROL", "SELECT tenant_id, ended_by, ended_at IS NOT NULL AS ended FROM support_sessions ORDER BY tenant_id");
  assert.deepEqual(sessions, [{ tenant_id: 1, ended_by: null, ended: 0 }, { tenant_id: 2, ended_by: "vendor-suspended", ended: 1 }],
    "only the suspended vendor's support session ended");
  // The vendor's own database is untouched; the other vendor still works.
  assert.deepEqual(server.query("DB_T2", "SELECT name FROM items"), [{ name: "acme-marker" }]);
  assert.equal((await get("demo", "/api/auth/me")).status, 401);
});

test("suspend refuses: already suspended, unknown slug, and changes nothing", () => {
  const before = server.query("CONTROL", "SELECT count(*) AS n FROM audit_log")[0].n;
  const again = script("suspend-tenant.mjs", "acme");
  assert.equal(again.code, 1);
  assert.match(again.out, /already suspended/);
  const unknown = script("suspend-tenant.mjs", "nosuch");
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /No vendor with the slug "nosuch"/);
  const resumeActive = script("suspend-tenant.mjs", "demo", "--resume");
  assert.equal(resumeActive.code, 1);
  assert.match(resumeActive.out, /active, not suspended/);
  assert.equal(server.query("CONTROL", "SELECT count(*) AS n FROM audit_log")[0].n, before);
  assert.equal(status("demo"), "active");
});

test("--resume: a suspended vendor is active again and works; both changes audited", async () => {
  assert.equal(script("suspend-tenant.mjs", "paused").code, 0);
  const r = script("suspend-tenant.mjs", "paused", "--resume");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /is active again/);
  assert.equal(status("paused"), "active");
  assert.equal((await get("paused", "/api/auth/me")).status, 401, "a normal vendor again: just not logged in");
  assert.deepEqual(audit(3).map((a) => a.action), ["vendor.suspended", "vendor.unsuspended"]);
});

test("delete refuses an active vendor and a missing or wrong --confirm, and changes nothing", () => {
  for (const args of [["demo", "--confirm", "demo"], ["gone"], ["gone", "--confirm", "demo"], ["gone", "--confirm", "GONE"]]) {
    const r = script("delete-tenant.mjs", ...args);
    assert.equal(r.code, 1, args.join(" "));
  }
  assert.match(script("delete-tenant.mjs", "demo", "--confirm", "demo").out, /demo" is active\. Suspend it first/);
  assert.equal(status("demo"), "active");
  assert.equal(status("gone"), "active");
  assert.deepEqual(audit(1), []);
});

test("delete (soft): suspended -> deleted, 404 everywhere, binding gone from the config; database, row and slug kept", async () => {
  assert.equal(script("suspend-tenant.mjs", "gone").code, 0);
  const r = script("delete-tenant.mjs", "gone", "--confirm", "gone", "--reason", "Closed the shop");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /is marked deleted/);
  assert.match(r.out, /can never be used again/);
  assert.match(r.out, /its database still exists, with all its data/);
  assert.match(r.out, /venstock-local-t4, id local-t4\) is still in/);
  assert.equal(status("gone"), "deleted");
  for (const path of ["/", "/api/auth/me"]) assert.equal((await get("gone", path)).status, 404, path);
  assert.deepEqual(audit(4).map((a) => [a.action, a.detail]), [
    ["vendor.suspended", "by scripts/suspend-tenant.mjs"],
    ["vendor.deleted", "by scripts/delete-tenant.mjs; reason: Closed the shop"],
  ]);
  // Nothing dropped: the vendor's database and its registry row are still there.
  assert.deepEqual(server.query("DB_T4", "SELECT name FROM items"), [{ name: "gone-marker" }]);
  assert.deepEqual(server.query("DB_T4", "SELECT tenant_id, slug FROM vendor_identity"), [{ tenant_id: 4, slug: "gone" }]);
  const config = readFileSync(join(gen, "wrangler.toml"), "utf8");
  assert.doesNotMatch(config, /binding = "DB_T4"/);
  for (const b of ["DB_T1", "DB_T2", "DB_T3"]) assert.match(config, new RegExp(`binding = "${b}"`), "the other vendors keep their bindings");
});

test("after delete: no resume, no second delete, and the slug can't be reused", () => {
  const resume = script("suspend-tenant.mjs", "gone", "--resume");
  assert.equal(resume.code, 1);
  assert.match(resume.out, /deleted; a deleted vendor can't be suspended or resumed/);
  const again = script("delete-tenant.mjs", "gone", "--confirm", "gone");
  assert.equal(again.code, 1);
  assert.match(again.out, /already deleted/);
  const reuse = script("create-tenant.mjs", "gone", "New Gone", "new@gone.test");
  assert.equal(reuse.code, 1);
  assert.match(reuse.out, /can't be reused/);
  assert.equal(server.query("CONTROL", "SELECT count(*) AS n FROM tenants WHERE slug = 'gone'")[0].n, 1);
});

test("the demo vendor was never affected", async () => {
  assert.equal(status("demo"), "active");
  const client = server.client("demo.localhost");
  await client.login(USERS.admin);
  assert.deepEqual((await client.get("/api/items")).json.map((i) => i.name), ["demo-marker"]);
});
