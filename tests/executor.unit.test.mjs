// Statements (scripts/lib/executor.mjs) and who may build the remote executor. No database, no wrangler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stmt, inline, isStmt } from "../scripts/lib/executor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("stmt: placeholders must match parameters; only strings, whole numbers and null", () => {
  assert.ok(isStmt(stmt("SELECT ?", 1)));
  assert.throws(() => stmt("SELECT ?, ?", 1), /2 placeholders but 1/);
  assert.throws(() => stmt("SELECT 1", 1), /0 placeholders but 1/);
  for (const bad of [1.5, NaN, Infinity, true, undefined, {}, [], 2 ** 60]) assert.throws(() => stmt("SELECT ?", bad), /unsupported parameter/, String(bad));
  assert.throws(() => stmt("SELECT 'oops", 1), /unterminated quote/);
  assert.ok(!isStmt({ sql: "SELECT 1", params: [] }), "a look-alike object is not a statement");
});

test("a ? inside quotes is text, not a placeholder", () => {
  const s = stmt("SELECT '?' AS q, \"a?b\" AS r, ? AS v", "x");
  assert.equal(inline(s), "SELECT '?' AS q, \"a?b\" AS r, 'x' AS v");
});

test("remote rendering escapes every string, so values can't become SQL", () => {
  const evil = "x'); DROP TABLE tenants; --";
  assert.equal(inline(stmt("UPDATE t SET a = ?, b = ?, c = ? WHERE id = ?", evil, null, 7, "O'Brien")),
    "UPDATE t SET a = 'x''); DROP TABLE tenants; --', b = NULL, c = 7 WHERE id = 'O''Brien'");
  assert.equal(inline(stmt("SELECT ?", "?")), "SELECT '?'", "a ? inside a value is not re-expanded");
});

test("only d1-target builds the remote executor, and only for remote", () => {
  const files = (dir) => readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")).map((f) => join(dir, f));
  const users = [...files(join(ROOT, "scripts")), ...files(join(ROOT, "src"))].filter((f) => /remoteExecutor\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(users.map((f) => f.slice(ROOT.length + 1)).sort(), ["scripts/lib/d1-target.mjs", "scripts/lib/executor.mjs"]);
  const target = readFileSync(join(ROOT, "scripts", "lib", "d1-target.mjs"), "utf8");
  assert.equal(target.match(/remoteExecutor\(/g).length, 1);
  assert.match(target, /: remote \? remoteExecutor\(\) : localExecutor\(/);
  assert.match(target, /return \{ positional, flags, remote: !!flags\["--remote"\] \};/, "remote comes only from the --remote flag");
  for (const f of files(join(ROOT, "scripts")).filter((f) => !f.includes(`${join("scripts", "lib")}`))) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /lib\/executor\.mjs|lib\/local-d1\.mjs/, `${f} goes through d1-target`);
  }
});
