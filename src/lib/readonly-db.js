// A vendor database that can only be read: what request handlers get during a support session. The Worker already
// refuses every support request that isn't GET (and no GET changes anything); this is the second lock, so a GET that
// someday writes would fail instead of writing.
//   prepare: only a single SELECT statement (no "WITH ... DELETE", no PRAGMA, nothing after a semicolon)
//   batch:   only statements made by this wrapper
//   exec, dump, withSession: not available
const SELECT_ONLY = /^\s*SELECT\b/i;
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i;

export class ReadOnlyError extends Error {}

export function readOnlyDb(db) {
  const made = new WeakSet();
  const refuse = (why) => { throw new ReadOnlyError(`read-only support session: ${why}`); };
  return Object.freeze({
    prepare(sql) {
      const text = String(sql);
      if (!SELECT_ONLY.test(text)) refuse("only SELECT statements");
      if (WRITE_WORDS.test(text.replace(/'(?:[^']|'')*'/g, "''"))) refuse("statement contains a write keyword");
      if (/;\s*\S/.test(text)) refuse("one statement at a time");
      const stmt = db.prepare(text);
      made.add(stmt);
      // bind() returns a new statement object in D1; keep tracking it.
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...args) => { const b = bind(...args); made.add(b); return b; };
      return stmt;
    },
    batch(stmts) {
      if (!Array.isArray(stmts) || !stmts.every((s) => made.has(s))) refuse("batch of statements not made read-only");
      return db.batch(stmts);
    },
    exec() { refuse("exec is not available"); },
    dump() { refuse("dump is not available"); },
  });
}
