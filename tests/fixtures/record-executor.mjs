// Loaded with `node --import` by tests/executor-parity.test.mjs, never by the scripts themselves. Replaces both
// executors (local and remote) with one that records every operation and runs it against throwaway local SQLite
// files, so a "--remote" run behaves exactly like a local one and never reaches wrangler or Cloudflare.
//   VENSTOCK_RECORD_LOG    file to append one JSON line per operation to
//   VENSTOCK_RECORD_STATE  folder for the throwaway database files
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { localQuery, localRunStatements, localRun } from "../../scripts/lib/local-d1.mjs";

const LOG = process.env.VENSTOCK_RECORD_LOG;
const STATE = process.env.VENSTOCK_RECORD_STATE;
if (!LOG || !STATE) throw new Error("record-executor: set VENSTOCK_RECORD_LOG and VENSTOCK_RECORD_STATE");
const record = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\n");

globalThis[Symbol.for("venstock.test.executor")] = ({ mode, root }) => {
  record({ op: "executor", mode });
  return {
    mode,
    run(stmts, ctx) {
      for (const s of stmts) record({ op: "run", mode, binding: ctx.binding, sql: s.sql, params: s.params });
      localRunStatements(STATE, ctx.databaseId, stmts);
    },
    query(s, ctx) {
      record({ op: "query", mode, binding: ctx.binding, sql: s.sql, params: s.params });
      return localQuery(STATE, ctx.databaseId, s.sql, s.params);
    },
    // Applies the repo's migration files the way wrangler does (one transaction per file, recorded in d1_migrations).
    applyMigrations(ctx) {
      record({ op: "applyMigrations", mode, binding: ctx.binding });
      const dir = join(root, "migrations", ctx.binding === "CONTROL" ? "control" : "vendor");
      localRun(STATE, ctx.databaseId, "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
      const done = new Set(localQuery(STATE, ctx.databaseId, "SELECT name FROM d1_migrations").map((r) => r.name));
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
        if (done.has(f)) continue;
        localRun(STATE, ctx.databaseId, `${readFileSync(join(dir, f), "utf8")}\nINSERT INTO d1_migrations (name) VALUES ('${f}');`);
      }
      return { ok: true, output: "" };
    },
    createDatabase(name) {
      record({ op: "createDatabase", mode, name });
      const h = createHash("sha256").update(name).digest("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    },
  };
};
