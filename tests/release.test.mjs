// scripts/build-config.mjs and scripts/release.mjs, rehearsed locally (--local) on throwaway databases.
// A wrapper `npx` records every command (then runs the real one), so the tests can prove nothing is ever deployed
// or tagged. A fake `node` on the PATH stands in for the test suite where needed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync, cpSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { localSql } from "./local-sql.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-11-21T12:00:00Z";
let dir, env, npxLog;

function node(script, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", script), ...args], { cwd: ROOT, encoding: "utf8", env: { ...env, ...extraEnv } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const release = (...args) => node("release.mjs", ["--local", "--skip-tests", "--now", NOW, ...args]);
const sql = (command, json = true) => localSql(env.VENSTOCK_PERSIST_TO)("CONTROL", command, json);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "venstock-release-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  npxLog = join(dir, "npx.log");
  const realNpx = spawnSync("sh", ["-c", "command -v npx"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "npx"), `#!/bin/sh\nprintf '%s\\n' "$(echo "$*" | tr '\\n' ' ')" >> "${npxLog}"\nexec "${realNpx}" "$@"\n`);
  chmodSync(join(bin, "npx"), 0o755);
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VENSTOCK_PERSIST_TO: join(dir, "state"), VENSTOCK_GENERATED_DIR: join(dir, "gen") };

  // release.mjs only reads the control database: the registry, and which control migrations wrangler recorded.
  // Seeded directly as a fully migrated state (the runner itself is tested in migrate.test.mjs).
  const files = (k) => readdirSync(join(ROOT, "migrations", k)).filter((f) => f.endsWith(".sql")).sort();
  sql(files("control").map((f) => readFileSync(join(ROOT, "migrations", "control", f), "utf8")).join("\n") + `
    CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
    ${files("control").map((f) => `INSERT INTO d1_migrations (name) VALUES ('${f}');`).join("\n")}`, false);
  const latest = files("vendor").at(-1);
  const row = (id, slug, status, dbId, changed = NOW) =>
    `(${id}, '${slug}', '${slug}', '${status}', 'DB_T${id}', 'venstock-local-t${id}', ${dbId ? `'${dbId}'` : "NULL"}, '${latest}', '${changed}', '${changed}')`;
  sql(`INSERT INTO tenants (id, slug, name, status, db_binding, db_name, db_id, schema_version, created_at, status_changed_at) VALUES
    ${row(1, "demo", "active", "local-t1")}, ${row(2, "acme", "active", "local-t2")},
    ${row(3, "zeta", "provisioning", "local-t3", "2026-11-21T09:00:00Z")}`, false);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("build-config writes CONTROL plus every vendor database, provisioning ones included", () => {
  const r = node("build-config.mjs");
  assert.equal(r.code, 0, r.out);
  const cfg = readFileSync(join(env.VENSTOCK_GENERATED_DIR, "wrangler.toml"), "utf8");
  for (const b of ["CONTROL", "DB_T1", "DB_T2", "DB_T3"]) assert.match(cfg, new RegExp(`binding = "${b}"`));
  assert.match(cfg, /database_id = "local-t3"/);
  assert.doesNotMatch(cfg, /demo|acme|zeta/, "slugs never become part of the config");
});

test("build-config refuses while an active vendor is behind on migrations", () => {
  sql("UPDATE tenants SET schema_version = NULL WHERE slug = 'acme'", false);
  try {
    const r = node("build-config.mjs");
    assert.equal(r.code, 1);
    assert.match(r.out, /acme \(t2\) at nothing/);
  } finally { assert.equal(node("migrate.mjs", ["--tenant", "acme"]).code, 0); }
});

test("release (local rehearsal): lists vendors, warns about provisioning, prints commands, deploys and tags nothing", () => {
  // The npx wrapper does record calls (so an empty log below means something).
  writeFileSync(npxLog, "");
  assert.equal(spawnSync("npx", ["--version"], { env, encoding: "utf8" }).status, 0);
  assert.equal(readFileSync(npxLog, "utf8").trim(), "--version");
  writeFileSync(npxLog, "");
  const r = release();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Vendors in this release: 3/);
  assert.match(r.out, /WARNING: zeta \(t3\) has been provisioning for 3\.0 h/);
  // The exact config just written (absolute here: the test's config folder is outside the repo).
  assert.ok(r.out.includes(`npx wrangler deploy -c ${join(env.VENSTOCK_GENERATED_DIR, "wrangler.toml")}\n`), r.out);
  assert.match(r.out, /git tag release-20261121-1200 \w+ && git push origin release-20261121-1200/);
  const recorded = JSON.parse(readFileSync(join(env.VENSTOCK_GENERATED_DIR, "last-release.json"), "utf8"));
  assert.equal(recorded.count, 3);
  assert.deepEqual(recorded.slugs, ["demo", "acme", "zeta"]);
  // A local rehearsal reads the local database files directly: it starts no wrangler process at all, so in
  // particular never a deploy, versions or publish.
  assert.deepEqual(readFileSync(npxLog, "utf8").trim().split("\n").filter(Boolean), []);
});

test("release refuses an active vendor without a database id", () => {
  sql("INSERT INTO tenants (id, slug, name, status, db_binding, db_name, db_id, created_at, status_changed_at) VALUES (4, 'nodb', 'nodb', 'active', 'DB_T4', 'venstock-local-t4', NULL, 'x', 'x')", false);
  try {
    const r = release();
    assert.equal(r.code, 1);
    assert.match(r.out, /nodb \(t4\) is active but has no db_id/);
  } finally { sql("UPDATE tenants SET status = 'deleted' WHERE id = 4", false); }
});

test("release refuses when an active vendor or the control database is behind", () => {
  sql("UPDATE tenants SET schema_version = NULL WHERE slug = 'demo'", false);
  let r = release();
  assert.equal(r.code, 1);
  assert.match(r.out, /demo \(t1\) is at nothing/);
  assert.equal(node("migrate.mjs", ["--tenant", "demo"]).code, 0);

  sql("DELETE FROM d1_migrations", false); // control now looks behind
  r = release();
  assert.equal(r.code, 1);
  assert.match(r.out, /the control database is at nothing/);
  sql("INSERT INTO d1_migrations (name) VALUES ('0001_control.sql')", false);
  assert.equal(release().code, 0);
});

test("release refuses fewer vendors than last time unless --accept-removed names exactly who is gone", () => {
  assert.equal(release().code, 0); // records 3
  sql("UPDATE tenants SET status = 'deleted' WHERE slug = 'acme'", false);
  try {
    let r = release();
    assert.equal(r.code, 1);
    assert.match(r.out, /2 vendors, fewer than the 3 at the last release.*Missing: acme/s);
    assert.equal(release("--accept-removed", "demo").code, 1, "naming the wrong vendor is refused");
    assert.equal(release("--accept-removed", "acme,demo").code, 1, "naming extra vendors is refused");
    r = release("--accept-removed", "acme");
    assert.equal(r.code, 0, r.out);
  } finally { sql("UPDATE tenants SET status = 'active' WHERE slug = 'acme'", false); }
  assert.equal(release().code, 0, "back to 3 is fine");
});

test("release runs the test suite and refuses when it fails", () => {
  const fakeBin = join(dir, "fake-node-bin");
  mkdirSync(fakeBin, { recursive: true });
  const marker = join(dir, "suite-ran");
  // Only the test-suite run is faked (npx/wrangler also run on node, so everything else goes to the real one).
  writeFileSync(join(fakeBin, "node"), `#!/bin/sh\ncase "$1" in --test) echo "$*" > "${marker}"; exit 1;; esac\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(fakeBin, "node"), 0o755);
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "release.mjs"), "--local", "--now", NOW], {
    cwd: ROOT, encoding: "utf8", env: { ...env, PATH: `${fakeBin}:${env.PATH}` },
  });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /the test suite failed/);
  assert.match(readFileSync(marker, "utf8"), /--test tests\/\*\*\/\*\.test\.mjs/);
});
