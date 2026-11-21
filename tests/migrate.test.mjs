// scripts/migrate.mjs across several local databases: control + three vendors, a failure on one vendor, resume,
// no-op, checksum refusals. Everything runs in throwaway folders (VENSTOCK_PERSIST_TO / VENSTOCK_GENERATED_DIR) with a
// throwaway copy of the migrations (--migrations-root, local only).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { updateManifest } from "../scripts/lib/manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir, env, migs;

function migrate(...args) {
  const r = spawnSync("node", [join(ROOT, "scripts", "migrate.mjs"), "--migrations-root", migs, ...args], { cwd: ROOT, encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
// Direct SQL on a binding in the generated config (the runner rewrites it to include every registered vendor).
function sql(binding, command, json = true) {
  const r = spawnSync("npx", ["--no-install", "wrangler", "d1", "execute", binding, "--local", "--persist-to", env.VENSTOCK_PERSIST_TO,
    "-c", join(env.VENSTOCK_GENERATED_DIR, "wrangler.toml"), "--command", command, ...(json ? ["--json"] : [])], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return json ? JSON.parse(r.stdout)[0].results : null;
}
const tables = (b) => sql(b, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name != 'sqlite_sequence' ORDER BY name").map((r) => r.name);
const applied = (b) => sql(b, "SELECT name FROM d1_migrations ORDER BY id").map((r) => r.name);
const versions = () => Object.fromEntries(sql("CONTROL", "SELECT slug, schema_version FROM tenants ORDER BY id").map((r) => [r.slug, r.schema_version]));
const line = (out, db) => out.split("\n").find((l) => l.startsWith(db)) || "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "venstock-migrate-"));
  env = { ...process.env, VENSTOCK_PERSIST_TO: join(dir, "state"), VENSTOCK_GENERATED_DIR: join(dir, "gen") };
  migs = join(dir, "migrations");
  cpSync(join(ROOT, "migrations", "control"), join(migs, "control"), { recursive: true });
  cpSync(join(ROOT, "migrations", "vendor"), join(migs, "vendor"), { recursive: true });
});
after(() => rmSync(dir, { recursive: true, force: true }));

const now = "2026-11-21T00:00:00Z";
const tenantRow = (id, slug, status = "active", dbId = `local-t${id}`) =>
  `(${id}, '${slug}', '${slug}', '${status}', 'DB_T${id}', 'venstock-local-t${id}', ${dbId ? `'${dbId}'` : "NULL"}, '${now}', '${now}')`;

test("fresh: control, then three vendors get the baseline; deleted and database-less vendors are skipped", () => {
  const c = migrate("--control");
  assert.equal(c.code, 0, c.out);
  assert.match(line(c.out, "control"), /done\s+0001_control\.sql/);
  sql("CONTROL", `INSERT INTO tenants (id, slug, name, status, db_binding, db_name, db_id, created_at, status_changed_at) VALUES
    ${tenantRow(1, "demo")}, ${tenantRow(2, "acme")}, ${tenantRow(3, "zeta", "provisioning")},
    ${tenantRow(4, "gone", "deleted")}, ${tenantRow(5, "waiting", "provisioning", null)}`, false);
  const r = migrate();
  assert.equal(r.code, 0, r.out);
  for (const v of ["demo (t1)", "acme (t2)", "zeta (t3)"]) assert.match(line(r.out, v), /done\s+0001_baseline\.sql/, v);
  assert.match(line(r.out, "waiting (t5)"), /no database/);
  assert.doesNotMatch(r.out, /gone/);
  assert.deepEqual(versions(), { demo: "0001_baseline.sql", acme: "0001_baseline.sql", zeta: "0001_baseline.sql", gone: null, waiting: null });
  assert.ok(tables("DB_T1").includes("vendor_identity"));
  assert.ok(!tables("CONTROL").includes("items"), "vendor tables never go into control");
  assert.ok(!tables("DB_T1").includes("tenants"), "control tables never go into a vendor database");
});

test("a migration failing on vendor 2 only: vendor 1 done, vendor 2 rolled back, vendor 3 not started", () => {
  sql("DB_T2", "CREATE TABLE conflict_me (y INTEGER)", false); // makes 0002 fail on acme only
  writeFileSync(join(migs, "vendor", "0002_add_extra.sql"),
    "CREATE TABLE extra (x INTEGER);\nINSERT INTO extra VALUES (1);\nCREATE TABLE conflict_me (y INTEGER);\n");
  assert.deepEqual(updateManifest(join(migs, "vendor")).refused, []);

  const r = migrate();
  assert.equal(r.code, 1, r.out);
  assert.match(line(r.out, "demo (t1)"), /done\s+0002_add_extra\.sql/);
  assert.match(line(r.out, "acme (t2)"), /FAILED/);
  assert.match(line(r.out, "zeta (t3)"), /not started/);
  assert.match(r.out, /Stopped at acme \(t2\)/);
  assert.match(r.out, /conflict_me/);

  assert.deepEqual(applied("DB_T1"), ["0001_baseline.sql", "0002_add_extra.sql"]);
  assert.deepEqual(applied("DB_T2"), ["0001_baseline.sql"]);
  assert.ok(!tables("DB_T2").includes("extra"), "nothing from the failed file is kept on acme");
  assert.deepEqual(applied("DB_T3"), ["0001_baseline.sql"]);
  assert.ok(!tables("DB_T3").includes("extra"));
  assert.deepEqual(versions(), { demo: "0002_add_extra.sql", acme: "0001_baseline.sql", zeta: "0001_baseline.sql", gone: null, waiting: null });
});

test("after fixing the cause, the same command resumes and finishes; a third run changes nothing", () => {
  sql("DB_T2", "DROP TABLE conflict_me", false);
  const r = migrate();
  assert.equal(r.code, 0, r.out);
  assert.match(line(r.out, "demo (t1)"), /up to date/);
  assert.match(line(r.out, "acme (t2)"), /done\s+0002_add_extra\.sql/);
  assert.match(line(r.out, "zeta (t3)"), /done\s+0002_add_extra\.sql/);
  assert.deepEqual(sql("DB_T2", "SELECT x FROM extra"), [{ x: 1 }]);
  const again = migrate();
  assert.equal(again.code, 0, again.out);
  for (const v of ["control", "demo (t1)", "acme (t2)", "zeta (t3)"]) assert.match(line(again.out, v), /up to date/, v);
  assert.deepEqual(applied("DB_T1"), ["0001_baseline.sql", "0002_add_extra.sql"], "nothing applied twice");
});

test("--tenant migrates one vendor only", () => {
  writeFileSync(join(migs, "vendor", "0003_one_more.sql"), "CREATE TABLE IF NOT EXISTS one_more (x INTEGER);\n");
  updateManifest(join(migs, "vendor"));
  const r = migrate("--tenant", "acme");
  assert.equal(r.code, 0, r.out);
  assert.match(line(r.out, "acme (t2)"), /done\s+0003_one_more\.sql/);
  assert.doesNotMatch(r.out, /demo|zeta/);
  assert.ok(!tables("DB_T1").includes("one_more"));
  assert.equal(migrate("--tenant", "nosuch").code, 1);
  assert.equal(migrate("--tenant", "gone").code, 1, "abandoned vendors are not migrated");
  const cfg = readFileSync(join(env.VENSTOCK_GENERATED_DIR, "wrangler.toml"), "utf8");
  for (const b of ["DB_T1", "DB_T2", "DB_T3"]) assert.match(cfg, new RegExp(`binding = "${b}"`), `--tenant must not drop ${b} from the config`);
  assert.equal(migrate("--vendors").code, 0, "bring the rest up to date");
});

test("a migration file changed after its checksum was recorded: refused before touching any database", () => {
  const before = applied("DB_T1");
  appendFileSync(join(migs, "vendor", "0002_add_extra.sql"), "-- sneaky edit\n");
  const r = migrate();
  assert.equal(r.code, 1);
  assert.match(r.out, /0002_add_extra\.sql: changed since its checksum was recorded/);
  assert.doesNotMatch(r.out, /About to touch/);
  assert.deepEqual(applied("DB_T1"), before);
});

test("a new migration file that isn't in checksums.json: refused", () => {
  const fresh = mkdtempSync(join(tmpdir(), "venstock-migs-"));
  try {
    cpSync(join(ROOT, "migrations", "control"), join(fresh, "control"), { recursive: true });
    cpSync(join(ROOT, "migrations", "vendor"), join(fresh, "vendor"), { recursive: true });
    writeFileSync(join(fresh, "vendor", "0002_unrecorded.sql"), "SELECT 1;\n");
    const r = spawnSync("node", [join(ROOT, "scripts", "migrate.mjs"), "--migrations-root", fresh], { cwd: ROOT, encoding: "utf8", env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /0002_unrecorded\.sql: not in checksums\.json/);
  } finally { rmSync(fresh, { recursive: true, force: true }); }
});

test("remote refusals: custom migrations folder, and a CONTROL id that is still a placeholder", () => {
  const r1 = spawnSync("node", [join(ROOT, "scripts", "migrate.mjs"), "--migrations-root", migs, "--remote"], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(r1.status, 1);
  const r2 = spawnSync("node", [join(ROOT, "scripts", "migrate.mjs"), "--remote"], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /set CONTROL's database_id/);
  assert.equal(spawnSync("node", [join(ROOT, "scripts", "migrate.mjs"), "--control", "--vendors"], { cwd: ROOT, encoding: "utf8", env }).status, 1);
});
