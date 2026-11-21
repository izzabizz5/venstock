// Direct access to LOCAL D1 databases (the SQLite files wrangler keeps under --persist-to), without starting wrangler.
// Starting wrangler costs about 5 seconds per command; scripts and tests used to pay that for every single query.
//
// Local only: remote databases always go through wrangler (scripts/lib/d1-target.mjs). Migrations always go through
// `wrangler d1 migrations apply`, locally too, so the runner keeps wrangler's own per-file rollback.
//
// Where the file lives is miniflare's layout, not a documented API:
//   <persistTo>/v3/d1/miniflare-D1DatabaseObject/<id>.sqlite, id = the Durable Object id derived from database_id.
// tests/local-d1.test.mjs checks it against a real wrangler, so a wrangler upgrade that changes it fails loudly.
import { createHash, createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// node:sqlite prints an "experimental" warning on first use; it is noise in every script's output.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = emit;

const UNIQUE_KEY = "miniflare-D1DatabaseObject";

// miniflare's idFromName(): 16 bytes of HMAC(name) followed by 16 bytes of HMAC over those, both keyed by
// sha256(namespace key), as hex.
export function localD1File(persistTo, databaseId) {
  const key = createHash("sha256").update(UNIQUE_KEY).digest();
  const name = createHmac("sha256", key).update(String(databaseId)).digest().subarray(0, 16);
  const mac = createHmac("sha256", key).update(name).digest().subarray(0, 16);
  return join(persistTo, "v3", "d1", UNIQUE_KEY, `${Buffer.concat([name, mac]).toString("hex")}.sqlite`);
}

function open(persistTo, databaseId) {
  const file = localD1File(persistTo, databaseId);
  mkdirSync(join(file, ".."), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000"); // a running `wrangler dev` may hold a write lock briefly
  db.exec("PRAGMA foreign_keys = ON");   // as D1 does
  return db;
}
// Plain objects (node:sqlite returns null-prototype rows), the same shape `wrangler d1 execute --json` gives.
const plain = (rows) => rows.map((r) => ({ ...r }));

// One or more statements, all or nothing (like `wrangler d1 execute --command`).
export function localRun(persistTo, databaseId, sql) {
  const db = open(persistTo, databaseId);
  try {
    db.exec("BEGIN");
    try { db.exec(sql); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  } finally { db.close(); }
}

// One statement; its rows.
export function localQuery(persistTo, databaseId, sql) {
  const db = open(persistTo, databaseId);
  try { return plain(db.prepare(sql).all()); } finally { db.close(); }
}
