// scripts/seed-demo.mjs against throwaway local databases: fills "demo" only, keeps its users and identity, the data is
// consistent (sale totals, stock never negative, one running show), and it refuses to seed over existing items
// unless --replace. Starts wrangler (create-tenant applies migrations), so it belongs in test:full.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { localSql } from "./local-sql.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir, env;
const script = (name, args = []) => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", name), ...args], { cwd: ROOT, encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const sql = (binding, q) => localSql(env.VENSTOCK_PERSIST_TO)(binding, q);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "venstock-seed-"));
  env = { ...process.env, VENSTOCK_PERSIST_TO: join(dir, "state"), VENSTOCK_GENERATED_DIR: join(dir, "gen") };
  for (const [name, args] of [["migrate.mjs", ["--control"]], ["create-tenant.mjs", ["acme", "Acme Crafts", "owner@acme.test"]]]) {
    const r = script(name, args);
    assert.equal(r.code, 0, r.out);
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("without a local demo vendor it refuses and says how to create one", () => {
  const r = script("seed-demo.mjs");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /create-tenant\.mjs demo/);
});

test("fills demo only, consistently, and keeps its users and identity", () => {
  const c = script("create-tenant.mjs", ["demo", "Demo Shop", "owner@demo.test"]);
  assert.equal(c.code, 0, c.out);
  const r = script("seed-demo.mjs");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /About to touch LOCAL D1 databases/);
  assert.match(r.out, /demo\.localhost:8788/);

  const n = (q) => sql("DB_T2", q)[0].n;
  assert.ok(n("SELECT count(*) AS n FROM items") >= 20);
  assert.ok(n("SELECT count(*) AS n FROM items WHERE stock = 0 AND active = 1") >= 1, "some items are sold out");
  assert.equal(n("SELECT count(*) AS n FROM items WHERE stock < 0"), 0);
  assert.equal(n("SELECT count(*) AS n FROM items WHERE active = 0"), 1);
  assert.equal(n("SELECT count(*) AS n FROM shows WHERE ended_at IS NULL"), 1, "exactly one running show");
  assert.equal(n("SELECT count(*) AS n FROM upcoming_shows"), 3);
  assert.ok(n("SELECT count(*) AS n FROM sales") >= 30);
  assert.equal(n("SELECT count(*) AS n FROM sales WHERE show_id IS NULL OR show_id NOT IN (SELECT id FROM shows WHERE ended_at IS NULL)"), 0);
  assert.equal(n("SELECT count(*) AS n FROM sales WHERE voided = 1"), 1);
  assert.equal(n("SELECT count(*) AS n FROM sale_items WHERE item_id IS NULL OR sale_id IS NULL"), 0);
  assert.equal(n(`SELECT count(*) AS n FROM sales s WHERE s.subtotal_cents !=
    (SELECT sum(qty * price_cents) FROM sale_items WHERE sale_id = s.id) OR s.total_cents != s.subtotal_cents - s.discount_cents
    OR s.discount_cents < 0`), 0, "every sale's subtotal and total add up");
  assert.deepEqual(sql("DB_T2", "SELECT tenant_id, slug FROM vendor_identity"), [{ tenant_id: 2, slug: "demo" }]);
  assert.deepEqual(sql("DB_T2", "SELECT email FROM users"), [{ email: "owner@demo.test" }]);
  assert.equal(sql("DB_T1", "SELECT count(*) AS n FROM items")[0].n, 0, "the other vendor is untouched");
});

test("refuses to seed over existing items; --replace wipes and seeds again", () => {
  const before = sql("DB_T2", "SELECT count(*) AS n FROM sales")[0].n;
  const again = script("seed-demo.mjs");
  assert.equal(again.code, 1, again.out);
  assert.match(again.out, /already has \d+ items.*--replace/s);
  const r = script("seed-demo.mjs", ["--replace"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(sql("DB_T2", "SELECT count(*) AS n FROM sales")[0].n, before, "same data, not doubled");
  assert.equal(sql("DB_T2", "SELECT count(*) AS n FROM shows WHERE ended_at IS NULL")[0].n, 1);
  assert.deepEqual(sql("DB_T2", "SELECT email FROM users"), [{ email: "owner@demo.test" }], "users survive --replace");
});
