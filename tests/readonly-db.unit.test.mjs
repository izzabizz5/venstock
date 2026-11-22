// src/lib/readonly-db.js: the database a support session's handlers get. Only single SELECT statements get through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readOnlyDb, ReadOnlyError } from "../src/lib/readonly-db.js";

function fakeDb() {
  const made = [];
  const stmt = (sql) => ({ sql, bind(...a) { const b = stmt(sql); b.args = a; made.push(b); return b; }, async all() { return { results: [] }; } });
  return { made, prepare(sql) { const s = stmt(sql); made.push(s); return s; }, async batch(s) { return s.map(() => ({ results: [] })); },
    exec() { throw new Error("real exec reached"); } };
}

test("single SELECT statements pass, with bind, first/all and batch", async () => {
  const db = readOnlyDb(fakeDb());
  const s = db.prepare("SELECT * FROM items WHERE id = ?").bind(1);
  assert.deepEqual(await s.all(), { results: [] });
  for (const sql of ["  select 1", "SELECT name FROM items WHERE status = 'deleted' OR name = 'update me'", "SELECT * FROM sales WHERE notes LIKE '%insert%'"]) {
    assert.doesNotThrow(() => db.prepare(sql), sql);
  }
  await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT ?").bind(2)]);
});

test("anything that could write is refused before it reaches the database", () => {
  const real = fakeDb();
  const db = readOnlyDb(real);
  for (const sql of ["INSERT INTO items (name) VALUES ('x')", "UPDATE items SET stock = 0", "DELETE FROM sales", "REPLACE INTO settings VALUES ('a','b')",
    "WITH x AS (SELECT 1) DELETE FROM items", "PRAGMA foreign_keys = OFF", "DROP TABLE items", "CREATE TABLE t (x)", "ATTACH 'x' AS y",
    "SELECT 1; DELETE FROM items", "SELECT * FROM items WHERE id IN (SELECT id FROM items); UPDATE items SET stock = 1",
    "SELECT 1 FROM items WHERE 1 = (DELETE FROM items)", "VACUUM", "  ", ""]) {
    assert.throws(() => db.prepare(sql), ReadOnlyError, sql);
  }
  assert.equal(real.made.length, 0, "nothing was prepared on the real database");
});

test("batch only takes statements made by the wrapper; exec and dump are not available", async () => {
  const real = fakeDb();
  const db = readOnlyDb(real);
  await assert.rejects(async () => db.batch([real.prepare("DELETE FROM items")]), ReadOnlyError);
  await assert.rejects(async () => db.batch("x"), ReadOnlyError);
  assert.throws(() => db.exec("DELETE FROM items"), ReadOnlyError);
  assert.throws(() => db.dump(), ReadOnlyError);
  assert.ok(Object.isFrozen(db));
});

test("account secrets and sessions are never readable, even with SELECT", () => {
  const real = fakeDb();
  const db = readOnlyDb(real);
  for (const sql of ["SELECT password_hash FROM users", "SELECT totp_secret FROM users WHERE id = 1", "SELECT invite_hash, email FROM users",
    "SELECT * FROM users", "SELECT u.* FROM users u", "SELECT id FROM sessions", "SELECT s.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id",
    "SELECT email FROM users WHERE password_hash = 'x'"]) {
    assert.throws(() => db.prepare(sql), ReadOnlyError, sql);
  }
  assert.equal(real.made.length, 0);
  // The users list (src/lib/auth.js) still works: it only asks whether a password is set.
  assert.doesNotThrow(() => db.prepare(`SELECT id, email, is_admin, created_at, invite_expires,
                password_hash IS NOT NULL AS has_password, totp_enabled
         FROM users ORDER BY email`));
  assert.doesNotThrow(() => db.prepare("SELECT count(*) AS n FROM users"));
  assert.doesNotThrow(() => db.prepare("SELECT * FROM items ORDER BY id"));
});
