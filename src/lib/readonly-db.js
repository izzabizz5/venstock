// A vendor database that can only be read: what request handlers get during a support session. The Worker already
// refuses every support request that isn't GET (and no GET changes anything); this is the second lock, so a GET that
// someday writes would fail instead of writing.
//   prepare: only a single SELECT statement (no "WITH ... DELETE", no PRAGMA, nothing after a semicolon), and never
//            account secrets (password hashes, authenticator secrets, invites) or the sessions table
//   batch:   only statements made by this wrapper
//   exec, dump, withSession: not available
const SELECT_ONLY = /^\s*SELECT\b/i;
// Never readable in a support session: anything that could take over an account. The users list may still ask
// whether a password is set ("password_hash IS NOT NULL"), never for the hash itself.
const SECRET_COLUMNS = /\b(password_hash|totp_secret|invite_hash)\b/i;
const SESSIONS_TABLE = /\bsessions\b/i;
const ACCOUNT_TABLES = /\b(users|sessions)\b/i;
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
      if (SECRET_COLUMNS.test(text.replace(/\bpassword_hash\s+IS\s+NOT\s+NULL\b/gi, ""))) refuse("account secrets are not readable");
      if (SESSIONS_TABLE.test(text)) refuse("sessions are not readable");
      if (ACCOUNT_TABLES.test(text) && /(^|[\s,.(])\*/.test(text.replace(/count\(\*\)/gi, ""))) refuse("no * on account tables");
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
