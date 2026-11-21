// scripts/lib/local-d1.mjs reads and writes wrangler's local database files directly (for speed). Where those files
// live is miniflare's layout, not a documented API, so this checks it against the real wrangler: rows written by
// either side must be seen by the other. If a wrangler upgrade changes the layout, this fails (and so would every
// script and test relying on it).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { localRun, localQuery, localD1File } from "../scripts/lib/local-d1.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir, config;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "venstock-local-d1-"));
  config = join(dir, "wrangler.toml");
  writeFileSync(config, `name = "x"\nmain = ${JSON.stringify(join(ROOT, "src", "worker.js"))}\ncompatibility_date = "2024-11-01"\n` +
    `[[d1_databases]]\nbinding = "DB_T1"\ndatabase_name = "venstock-local-t1"\ndatabase_id = "local-t1"\n`);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const wrangler = (sql) => {
  const r = spawnSync("npx", ["--no-install", "wrangler", "d1", "execute", "DB_T1", "--local", "--persist-to", dir, "-c", config, "--command", sql, "--json"],
    { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout).at(-1).results;
};

test("node writes, wrangler reads and writes, node reads: same database file", () => {
  localRun(dir, "local-t1", "CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('by-node');");
  assert.ok(existsSync(localD1File(dir, "local-t1")));
  assert.deepEqual(wrangler("INSERT INTO marker VALUES ('by-wrangler'); SELECT v FROM marker ORDER BY v"), [{ v: "by-node" }, { v: "by-wrangler" }]);
  assert.deepEqual(localQuery(dir, "local-t1", "SELECT v FROM marker ORDER BY v"), [{ v: "by-node" }, { v: "by-wrangler" }]);
});

test("localRun is all or nothing, and enforces foreign keys like D1", () => {
  assert.throws(() => localRun(dir, "local-t1", "INSERT INTO marker VALUES ('half'); INSERT INTO nosuch VALUES (1);"));
  assert.deepEqual(localQuery(dir, "local-t1", "SELECT count(*) AS n FROM marker WHERE v = 'half'"), [{ n: 0 }]);
  localRun(dir, "local-t1", "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (p INTEGER REFERENCES parent(id));");
  assert.throws(() => localRun(dir, "local-t1", "INSERT INTO child VALUES (42)"), /FOREIGN KEY/);
});
