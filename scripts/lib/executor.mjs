// How a script's SQL reaches a database. Scripts build each statement ONCE, as stmt(sql, ...params) with `?`
// placeholders, and hand it to d1-target, which checks the binding and passes it to one of two executors:
//   local  -> node:sqlite on wrangler's local files (params bound natively)
//   remote -> `wrangler d1 execute --remote` (the CLI can't bind params, so they are rendered as SQL literals here,
//             and only here)
// Both get exactly the same statements, in the same order (tests/executor-parity.test.mjs records and compares them).
// Only d1-target.mjs constructs an executor, and it builds the remote one only for an explicit --remote.
import { spawnSync } from "node:child_process";
import { localQuery, localRunStatements } from "./local-d1.mjs";

const STMT = Symbol("venstock.stmt");

// A statement: SQL with `?` placeholders and its parameters (strings, integers or null).
export function stmt(sql, ...params) {
  for (const p of params) {
    if (!(p === null || typeof p === "string" || (typeof p === "number" && Number.isSafeInteger(p)))) {
      throw new Error(`stmt: unsupported parameter ${JSON.stringify(p)} (strings, whole numbers and null only)`);
    }
  }
  const holes = placeholders(sql);
  if (holes.length !== params.length) throw new Error(`stmt: ${holes.length} placeholders but ${params.length} parameters in: ${sql}`);
  return Object.freeze({ [STMT]: true, sql, params: Object.freeze([...params]) });
}
export const isStmt = (s) => !!(s && s[STMT]);

// Positions of `?` outside quoted strings and identifiers.
function placeholders(sql) {
  const at = [];
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "?") at.push(i);
  }
  if (quote) throw new Error(`stmt: unterminated quote in: ${sql}`);
  return at;
}

// SQL literal for one parameter (remote only).
export function literal(p) {
  if (p === null) return "NULL";
  if (typeof p === "number") return String(p);
  return `'${p.replace(/'/g, "''")}'`;
}
// The statement with its parameters rendered in place (remote only: the wrangler CLI has no parameter binding).
export function inline(s) {
  const holes = placeholders(s.sql);
  let out = "", from = 0;
  holes.forEach((pos, i) => { out += s.sql.slice(from, pos) + literal(s.params[i]); from = pos + 1; });
  return out + s.sql.slice(from);
}

// ctx (from d1-target, per call): { binding, databaseId, configPath, root }.
export function localExecutor({ persistTo }) {
  return {
    mode: "local",
    run(stmts, ctx) { localRunStatements(persistTo, ctx.databaseId, stmts); },
    query(s, ctx) { return localQuery(persistTo, ctx.databaseId, s.sql, s.params); },
    applyMigrations(ctx) { return wranglerApply(["--local", "--persist-to", persistTo], ctx); },
    createDatabase() { throw new Error("createDatabase is remote only (local databases appear on first use)"); },
  };
}

export function remoteExecutor() {
  const execute = (ctx, sql, json) => {
    const r = wrangler(["d1", "execute", ctx.binding, "--remote", "-c", ctx.configPath, "--command", sql, ...(json ? ["--json"] : [])], ctx.root);
    if (r.status !== 0) throw new Error(`d1 execute on ${ctx.binding} failed:\n${(r.stderr || r.stdout || "").trim()}`);
    return r;
  };
  return {
    mode: "remote",
    run(stmts, ctx) { execute(ctx, stmts.map(inline).join(";\n")); },
    query(s, ctx) { return JSON.parse(execute(ctx, inline(s), true).stdout)[0].results; },
    applyMigrations(ctx) { return wranglerApply(["--remote"], ctx); },
    createDatabase(name, ctx) {
      const r = wrangler(["d1", "create", name], ctx.root);
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      const id = out.match(/"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"/i)?.[1];
      if (r.status !== 0 || !id) throw new Error(`wrangler d1 create ${name} failed or printed no database_id:\n${out.trim()}`);
      return id;
    },
  };
}

// wrangler d1 migrations apply: each file is rolled back on error, and later files are not attempted.
function wranglerApply(where, ctx) {
  const r = wrangler(["d1", "migrations", "apply", ctx.binding, ...where, "-c", ctx.configPath, "--force"], ctx.root);
  return { ok: r.status === 0, output: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}
const wrangler = (args, cwd) => spawnSync("npx", ["wrangler", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
